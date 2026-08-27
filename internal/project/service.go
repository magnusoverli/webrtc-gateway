package project

import (
	"context"
	"errors"
	"fmt"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/controlplane"
	"webrtc-gateway/internal/settings"
)

type ChannelManager interface {
	List(context.Context) ([]channel.Channel, error)
	CleanupRuntime(context.Context, []channel.Channel) error
	Reconcile(context.Context) error
}

type SettingsManager interface {
	Get(context.Context) (settings.Settings, error)
	Reconcile(context.Context) error
}

type CompatibilityManager interface {
	ResetChannels(context.Context, []channel.Channel) error
}

type Service struct {
	store    Repository
	channels ChannelManager
	settings SettingsManager
	control  *controlplane.Coordinator
	compat   CompatibilityManager
	validate func(Configuration) error
	now      func() time.Time
}

func (s *Service) SetCompatibility(manager CompatibilityManager) { s.compat = manager }

func (s *Service) SetEnvironmentValidator(validate func(Configuration) error) { s.validate = validate }

func NewService(store Repository, channels ChannelManager, settings SettingsManager, control *controlplane.Coordinator) *Service {
	if control == nil {
		control = controlplane.NewCoordinator()
	}
	return &Service{store: store, channels: channels, settings: settings, control: control, now: time.Now}
}

func (s *Service) List(ctx context.Context) ([]Summary, error) {
	items, err := s.store.List(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Summary, len(items))
	for index, item := range items {
		result[index] = item.Summary()
	}
	return result, nil
}

func (s *Service) Get(ctx context.Context, id string) (Project, error) { return s.store.Get(ctx, id) }

func (s *Service) Save(ctx context.Context, name string) (Project, error) {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return Project{}, err
	}
	defer release()
	name, err = ValidateName(name)
	if err != nil {
		return Project{}, err
	}
	configuration, err := s.capture(ctx, true)
	if err != nil {
		return Project{}, err
	}
	return s.store.Create(ctx, name, configuration, s.now())
}

func (s *Service) Import(ctx context.Context, manifest Manifest) (Project, error) {
	validated, err := ValidateManifest(manifest, s.now())
	if err != nil {
		return Project{}, err
	}
	return s.store.Create(ctx, validated.Name, validated.Configuration, s.now())
}

func (s *Service) Rename(ctx context.Context, id, name string, expectedRevision int) (Project, error) {
	name, err := ValidateName(name)
	if err != nil {
		return Project{}, err
	}
	item, err := s.store.Get(ctx, id)
	if err != nil {
		return Project{}, err
	}
	if item.Revision != expectedRevision {
		return Project{}, ErrRevisionConflict
	}
	item.Name = name
	item.Revision++
	item.UpdatedAt = s.now().UTC()
	if err := s.store.Update(ctx, item, expectedRevision); err != nil {
		return Project{}, err
	}
	return item, nil
}

func (s *Service) Overwrite(ctx context.Context, id, name string, expectedRevision int) (Project, error) {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return Project{}, err
	}
	defer release()
	item, err := s.store.Get(ctx, id)
	if err != nil {
		return Project{}, err
	}
	if item.Revision != expectedRevision {
		return Project{}, ErrRevisionConflict
	}
	if name != "" {
		item.Name, err = ValidateName(name)
		if err != nil {
			return Project{}, err
		}
	}
	item.Configuration, err = s.capture(ctx, true)
	if err != nil {
		return Project{}, err
	}
	item.Revision++
	item.UpdatedAt = s.now().UTC()
	if err := s.store.Update(ctx, item, expectedRevision); err != nil {
		return Project{}, err
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, id string, expectedRevision int) error {
	return s.store.Delete(ctx, id, expectedRevision)
}

func (s *Service) Load(ctx context.Context, id string, expectedRevision int) (LoadResult, error) {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return LoadResult{}, err
	}
	defer release()
	item, err := s.store.Get(ctx, id)
	if err != nil {
		return LoadResult{}, err
	}
	if item.Revision != expectedRevision {
		return LoadResult{}, ErrRevisionConflict
	}
	configuration, err := ValidateConfiguration(item.Configuration, s.now())
	if err != nil {
		return LoadResult{}, err
	}
	if s.validate != nil {
		if err := s.validate(configuration); err != nil {
			return LoadResult{}, fmt.Errorf("%w: %v", ErrInvalid, err)
		}
	}
	previous, err := s.capture(ctx, false)
	if err != nil {
		return LoadResult{}, err
	}
	previousRuntime, err := s.channels.List(ctx)
	if err != nil {
		return LoadResult{}, fmt.Errorf("read live channels for cleanup: %w", err)
	}
	restartRequired := previous.Settings.ManagementBindAddress != configuration.Settings.ManagementBindAddress ||
		previous.Settings.ManagementPort != configuration.Settings.ManagementPort
	if err := s.replaceAndApply(ctx, previous, configuration, previousRuntime); err != nil {
		return LoadResult{}, err
	}
	return LoadResult{
		ProjectID: item.ID, ProjectRevision: item.Revision, ChannelCount: len(configuration.Channels),
		ManagementRestartRequired: restartRequired,
	}, nil
}

func (s *Service) replaceAndApply(ctx context.Context, previous, target Configuration, previousRuntime []channel.Channel) error {
	applyCtx, cancelApply := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancelApply()
	if err := s.store.ReplaceLive(applyCtx, target, s.now()); err != nil {
		return err
	}
	targetChannels := liveChannels(target, s.now())
	var applyErr error
	if s.compat != nil {
		applyErr = s.compat.ResetChannels(applyCtx, previousRuntime)
	}
	if applyErr == nil {
		applyErr = s.channels.CleanupRuntime(applyCtx, previousRuntime)
	}
	if applyErr == nil {
		applyErr = s.settings.Reconcile(applyCtx)
	}
	if applyErr == nil {
		applyErr = s.channels.Reconcile(applyCtx)
	}
	if applyErr == nil {
		return nil
	}
	rollbackCtx, cancelRollback := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancelRollback()
	rollbackStoreErr := s.store.ReplaceLive(rollbackCtx, previous, s.now())
	var rollbackApplyErr error
	if rollbackStoreErr == nil {
		if s.compat != nil {
			rollbackApplyErr = s.compat.ResetChannels(rollbackCtx, targetChannels)
		}
	}
	if rollbackStoreErr == nil && rollbackApplyErr == nil {
		rollbackApplyErr = s.channels.CleanupRuntime(rollbackCtx, targetChannels)
		pendingDeletion := deletingChannels(previousRuntime)
		if rollbackApplyErr == nil && len(pendingDeletion) > 0 {
			rollbackApplyErr = s.channels.CleanupRuntime(rollbackCtx, pendingDeletion)
		}
		if rollbackApplyErr == nil {
			rollbackApplyErr = s.settings.Reconcile(rollbackCtx)
		}
		if rollbackApplyErr == nil {
			rollbackApplyErr = s.channels.Reconcile(rollbackCtx)
		}
	}
	return &LoadError{Cause: applyErr, RollbackErr: errors.Join(rollbackStoreErr, rollbackApplyErr)}
}

func deletingChannels(items []channel.Channel) []channel.Channel {
	deleting := make([]channel.Channel, 0)
	for _, item := range items {
		if item.ApplyState == channel.ApplyDeleting {
			deleting = append(deleting, item)
		}
	}
	return deleting
}

func (s *Service) capture(ctx context.Context, requireSettled bool) (Configuration, error) {
	settingsValue, err := s.settings.Get(ctx)
	if err != nil {
		return Configuration{}, fmt.Errorf("read live settings: %w", err)
	}
	items, err := s.channels.List(ctx)
	if err != nil {
		return Configuration{}, fmt.Errorf("read live channels: %w", err)
	}
	if requireSettled && settingsValue.ApplyState != settings.ApplyApplied {
		return Configuration{}, fmt.Errorf("%w: global settings are %s", ErrLiveNotSettled, settingsValue.ApplyState)
	}
	configuration := Configuration{Settings: SettingsFrom(settingsValue), Channels: make([]Channel, 0, len(items))}
	for _, item := range items {
		if item.ApplyState == channel.ApplyDeleting {
			continue
		}
		if requireSettled && item.ApplyState != channel.ApplyApplied {
			return Configuration{}, fmt.Errorf("%w: channel %s is %s", ErrLiveNotSettled, item.Name, item.ApplyState)
		}
		configuration.Channels = append(configuration.Channels, ChannelFrom(item))
	}
	return ValidateConfiguration(configuration, s.now())
}

func liveChannels(configuration Configuration, now time.Time) []channel.Channel {
	items := make([]channel.Channel, len(configuration.Channels))
	for index, item := range configuration.Channels {
		items[index] = item.Live(1, now)
	}
	return items
}
