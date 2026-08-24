package settings

import (
	"context"
	"fmt"
	"net"
	"slices"
	"time"

	"webrtc-gateway/internal/controlplane"
	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
)

type GlobalManager interface {
	GetGlobal(context.Context) (mediamtx.GlobalConfig, error)
	PatchGlobal(context.Context, mediamtx.GlobalConfig) error
}

type ChannelReconciler interface {
	Reconcile(context.Context) error
	ReconcileMedia(context.Context, string, string) error
	ReconcileSRTListeners(context.Context) error
	ValidatePortPolicy(context.Context, int, int, []int) error
}

type Service struct {
	store      Repository
	media      GlobalManager
	channels   ChannelReconciler
	control    *controlplane.Coordinator
	now        func() time.Time
	interfaces func() ([]networkbind.InterfaceAddress, error)
}

func NewService(store Repository, media GlobalManager, channels ChannelReconciler, control *controlplane.Coordinator) *Service {
	if control == nil {
		control = controlplane.NewCoordinator()
	}
	return &Service{
		store: store, media: media, channels: channels, control: control,
		now: time.Now, interfaces: networkbind.Interfaces,
	}
}

func (s *Service) Get(ctx context.Context) (Settings, error) {
	return s.store.Get(ctx)
}

func (s *Service) Update(ctx context.Context, value Settings) (Settings, error) {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return Settings{}, err
	}
	defer release()

	current, err := s.store.Get(ctx)
	if err != nil {
		return Settings{}, err
	}
	validated, err := Validate(value, s.now())
	if err != nil {
		return Settings{}, err
	}
	effective, interfaceList, err := s.resolve(validated)
	if err != nil {
		return Settings{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if s.channels != nil {
		srtPort, _ := listenerPort("srtAddress", validated.SRTAddress, false)
		webrtcPort, _ := listenerPort("webRTCLocalUDPAddress", validated.WebRTCLocalUDPAddress, false)
		if err := s.channels.ValidatePortPolicy(ctx, validated.RTPPortMin, validated.RTPPortMax, []int{srtPort, webrtcPort}); err != nil {
			return Settings{}, err
		}
	}
	if err := s.store.Update(ctx, validated); err != nil {
		return Settings{}, err
	}
	return s.applyResolved(ctx, validated, effective, interfaceList, current.MediaBindAddress != validated.MediaBindAddress, true)
}

func (s *Service) RTPPortRange(ctx context.Context) (int, int, error) {
	value, err := s.store.Get(ctx)
	if err != nil {
		return 0, 0, err
	}
	return value.RTPPortMin, value.RTPPortMax, nil
}

func (s *Service) Reconcile(ctx context.Context) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	value, err := s.store.Get(ctx)
	if err != nil {
		return err
	}
	// Channel reconciliation is the controller's next desired-state step.
	_, err = s.apply(ctx, value, false, false)
	return err
}

func (s *Service) ReconcilePending(ctx context.Context) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	value, err := s.store.Get(ctx)
	if err != nil {
		return err
	}
	if value.ApplyState == ApplyApplied && !networkbind.IsInterfaceSelector(value.MediaBindAddress) {
		return nil
	}
	// A prior apply can fail after MediaMTX accepted the patch but before every
	// dependent channel was refreshed, so pending settings force a complete pass.
	_, err = s.apply(ctx, value, value.ApplyState != ApplyApplied, true)
	return err
}

func (s *Service) apply(ctx context.Context, value Settings, forceChannelReconcile, reconcileChannels bool) (Settings, error) {
	effective, interfaceList, err := s.resolve(value)
	if err != nil {
		return s.applyFailure(ctx, value, err)
	}
	return s.applyResolved(ctx, value, effective, interfaceList, forceChannelReconcile, reconcileChannels)
}

func (s *Service) resolve(value Settings) (Settings, []string, error) {
	var interfaces []networkbind.InterfaceAddress
	if networkbind.IsInterfaceSelector(value.MediaBindAddress) {
		var err error
		interfaces, err = s.interfaces()
		if err != nil {
			return Settings{}, nil, err
		}
	}
	effective, _, interfaceList, err := ResolveMedia(value, interfaces)
	if err != nil {
		return Settings{}, nil, fmt.Errorf("media binding: %w", err)
	}
	return effective, interfaceList, nil
}

func (s *Service) applyResolved(
	ctx context.Context,
	value Settings,
	effective Settings,
	interfaceList []string,
	forceChannelReconcile bool,
	reconcileChannels bool,
) (Settings, error) {
	desired := mediamtx.GlobalConfig{
		LogLevel:                    effective.LogLevel,
		ReadTimeout:                 effective.ReadTimeout,
		WriteTimeout:                effective.WriteTimeout,
		WriteQueueSize:              effective.WriteQueueSize,
		UDPMaxPayloadSize:           effective.UDPMaxPayloadSize,
		UDPReadBufferSize:           effective.UDPReadBufferSize,
		SRTAddress:                  effective.SRTAddress,
		WebRTCLocalUDPAddress:       effective.WebRTCLocalUDPAddress,
		WebRTCLocalTCPAddress:       effective.WebRTCLocalTCPAddress,
		WebRTCIPsFromInterfaces:     effective.WebRTCIPsFromInterfaces,
		WebRTCIPsFromInterfacesList: interfaceList,
		WebRTCAdditionalHosts:       effective.WebRTCAdditionalHosts,
		WebRTCHandshakeTimeout:      effective.WebRTCHandshakeTimeout,
		WebRTCTrackGatherTimeout:    effective.WebRTCTrackGatherTimeout,
	}
	current, err := s.media.GetGlobal(ctx)
	bindingChanged := forceChannelReconcile || current.SRTAddress != desired.SRTAddress || !sameListenerHosts(current, desired)
	patched := false
	if err == nil && !equalGlobal(current, desired) {
		err = s.media.PatchGlobal(ctx, desired)
		patched = err == nil
	}
	if err == nil && patched && bindingChanged {
		err = s.waitForMediaAPI(ctx)
	}
	if err == nil && reconcileChannels && s.channels != nil && (patched || forceChannelReconcile) {
		if bindingChanged {
			err = s.channels.ReconcileMedia(ctx, effective.MediaBindAddress, effective.SRTAddress)
		} else {
			err = s.channels.ReconcileSRTListeners(ctx)
		}
	}
	if err != nil {
		return s.applyFailure(ctx, value, err)
	}
	previousState := value.ApplyState
	previousError := value.ApplyError
	value.ApplyState = ApplyApplied
	value.ApplyError = ""
	if previousState != value.ApplyState || previousError != value.ApplyError {
		if err := s.store.SetApplyResult(ctx, value.ApplyState, ""); err != nil {
			return value, err
		}
	}
	return value, nil
}

func (s *Service) applyFailure(ctx context.Context, value Settings, applyErr error) (Settings, error) {
	previousState := value.ApplyState
	previousError := value.ApplyError
	value.ApplyState = ApplyError
	value.ApplyError = applyErr.Error()
	if previousState != value.ApplyState || previousError != value.ApplyError {
		if storeErr := s.store.SetApplyResult(ctx, value.ApplyState, value.ApplyError); storeErr != nil {
			return value, storeErr
		}
	}
	return value, applyErr
}

func (s *Service) waitForMediaAPI(ctx context.Context) error {
	_, lastErr := s.media.GetGlobal(ctx)
	if lastErr == nil {
		return nil
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(2 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout.C:
			return lastErr
		case <-ticker.C:
			if _, err := s.media.GetGlobal(ctx); err != nil {
				lastErr = err
				continue
			}
			return nil
		}
	}
}

func sameListenerHosts(left, right mediamtx.GlobalConfig) bool {
	return listenerHost(left.SRTAddress) == listenerHost(right.SRTAddress) &&
		listenerHost(left.WebRTCLocalUDPAddress) == listenerHost(right.WebRTCLocalUDPAddress) &&
		listenerHost(left.WebRTCLocalTCPAddress) == listenerHost(right.WebRTCLocalTCPAddress)
}

func listenerHost(address string) string {
	if address == "" {
		return ""
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return address
	}
	return host
}

func equalGlobal(left, right mediamtx.GlobalConfig) bool {
	return left.LogLevel == right.LogLevel &&
		left.ReadTimeout == right.ReadTimeout &&
		left.WriteTimeout == right.WriteTimeout &&
		left.WriteQueueSize == right.WriteQueueSize &&
		left.UDPMaxPayloadSize == right.UDPMaxPayloadSize &&
		left.UDPReadBufferSize == right.UDPReadBufferSize &&
		left.SRTAddress == right.SRTAddress &&
		left.WebRTCLocalUDPAddress == right.WebRTCLocalUDPAddress &&
		left.WebRTCLocalTCPAddress == right.WebRTCLocalTCPAddress &&
		left.WebRTCIPsFromInterfaces == right.WebRTCIPsFromInterfaces &&
		slices.Equal(left.WebRTCIPsFromInterfacesList, right.WebRTCIPsFromInterfacesList) &&
		slices.Equal(left.WebRTCAdditionalHosts, right.WebRTCAdditionalHosts) &&
		left.WebRTCHandshakeTimeout == right.WebRTCHandshakeTimeout &&
		left.WebRTCTrackGatherTimeout == right.WebRTCTrackGatherTimeout
}
