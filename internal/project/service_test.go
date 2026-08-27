package project

import (
	"context"
	"errors"
	"testing"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/settings"
)

type fakeRepository struct {
	project      Project
	replacements []Configuration
}

func (f *fakeRepository) List(context.Context) ([]Project, error)      { return []Project{f.project}, nil }
func (f *fakeRepository) Get(context.Context, string) (Project, error) { return f.project, nil }
func (f *fakeRepository) Create(_ context.Context, name string, configuration Configuration, now time.Time) (Project, error) {
	return Project{ID: "saved", Revision: 1, Name: name, Configuration: configuration, CreatedAt: now, UpdatedAt: now}, nil
}
func (f *fakeRepository) Update(context.Context, Project, int) error { return nil }
func (f *fakeRepository) Delete(context.Context, string, int) error  { return nil }
func (f *fakeRepository) ReplaceLive(_ context.Context, value Configuration, _ time.Time) error {
	f.replacements = append(f.replacements, value)
	return nil
}

type fakeChannelManager struct {
	items          []channel.Channel
	reconcileCalls int
	reconcileErr   error
	cleanupCalls   int
}

func (f *fakeChannelManager) List(context.Context) ([]channel.Channel, error) { return f.items, nil }
func (f *fakeChannelManager) CleanupRuntime(context.Context, []channel.Channel) error {
	f.cleanupCalls++
	return nil
}
func (f *fakeChannelManager) Reconcile(context.Context) error {
	f.reconcileCalls++
	if f.reconcileCalls == 1 {
		return f.reconcileErr
	}
	return nil
}

type fakeSettingsManager struct {
	value          settings.Settings
	reconcileCalls int
}

func (f *fakeSettingsManager) Get(context.Context) (settings.Settings, error) { return f.value, nil }
func (f *fakeSettingsManager) Reconcile(context.Context) error {
	f.reconcileCalls++
	return nil
}

func TestLoadAutomaticallyRestoresPreviousConfigurationAfterApplyFailure(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	target := validConfiguration(now)
	target.Channels[0].Name = "Target"
	previousChannel := target.Channels[0].Live(4, now)
	previousChannel.Name = "Previous"
	previousChannel.ApplyState = channel.ApplyApplied
	settingsValue := target.Settings.Live(now)
	settingsValue.Revision = 4
	settingsValue.ApplyState = settings.ApplyApplied
	repository := &fakeRepository{project: Project{
		ID: "project-1", Revision: 3, Name: "Target", Configuration: target,
	}}
	channels := &fakeChannelManager{items: []channel.Channel{previousChannel}, reconcileErr: errors.New("listener unavailable")}
	settingsManager := &fakeSettingsManager{value: settingsValue}
	service := NewService(repository, channels, settingsManager, nil)
	service.now = func() time.Time { return now }

	_, err := service.Load(context.Background(), "project-1", 3)
	var loadErr *LoadError
	if !errors.As(err, &loadErr) || loadErr.RollbackErr != nil {
		t.Fatalf("error = %#v", err)
	}
	if len(repository.replacements) != 2 {
		t.Fatalf("replacement count = %d", len(repository.replacements))
	}
	if repository.replacements[0].Channels[0].Name != "Target" || repository.replacements[1].Channels[0].Name != "Previous" {
		t.Fatalf("replacement sequence = %+v", repository.replacements)
	}
	if channels.cleanupCalls != 2 || channels.reconcileCalls != 2 || settingsManager.reconcileCalls != 2 {
		t.Fatalf("calls cleanup=%d channel=%d settings=%d", channels.cleanupCalls, channels.reconcileCalls, settingsManager.reconcileCalls)
	}
}

func TestSaveRequiresAppliedLiveConfiguration(t *testing.T) {
	now := time.Now()
	configuration := validConfiguration(now)
	item := configuration.Channels[0].Live(1, now)
	item.ApplyState = channel.ApplyError
	settingsValue := configuration.Settings.Live(now)
	settingsValue.ApplyState = settings.ApplyApplied
	service := NewService(&fakeRepository{}, &fakeChannelManager{items: []channel.Channel{item}}, &fakeSettingsManager{value: settingsValue}, nil)
	if _, err := service.Save(context.Background(), "Broken"); !errors.Is(err, ErrLiveNotSettled) {
		t.Fatalf("error = %v", err)
	}
}

func TestCommittedLoadRollsBackAfterCallerCancellation(t *testing.T) {
	now := time.Now()
	repository := &fakeRepository{}
	channels := &fakeChannelManager{reconcileErr: errors.New("apply failed")}
	service := NewService(repository, channels, &fakeSettingsManager{}, nil)
	service.now = func() time.Time { return now }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	previous := validConfiguration(now)
	err := service.replaceAndApply(ctx, previous, validConfiguration(now), liveChannels(previous, now))
	var loadErr *LoadError
	if !errors.As(err, &loadErr) || loadErr.RollbackErr != nil || len(repository.replacements) != 2 {
		t.Fatalf("error = %#v, replacements = %d", err, len(repository.replacements))
	}
}
