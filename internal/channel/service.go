package channel

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"reflect"
	"strconv"
	"time"

	"webrtc-gateway/internal/controlplane"
	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
)

type PathManager interface {
	ReplacePath(context.Context, string, mediamtx.PathConfig) error
	DeletePath(context.Context, string) error
}

type PortPolicy interface {
	MediaPolicy(context.Context) (rtpMinimum, rtpMaximum int, srtAddress, mediaBind string, reservedUDPPorts []int, err error)
}

type SRTListener struct {
	ChannelID          string
	Path               string
	Mode               InputMode
	BindAddress        string
	Port               int
	Host               string
	StreamID           string
	LatencyMS          int
	SDP                string
	DestinationAddress string
	Passphrase         string
}

type SRTIngestPlan struct {
	Listener          SRTListener
	Source            string
	RTPSDP            string
	PublishPassphrase string
	OutputAddress     string
}

type SRTListenerManager interface {
	Prepare(context.Context, SRTListener) (SRTIngestPlan, error)
	Ensure(context.Context, SRTIngestPlan) error
	Stop(context.Context, string) error
}

type Service struct {
	store      Repository
	media      PathManager
	portPolicy PortPolicy
	srt        SRTListenerManager
	control    *controlplane.Coordinator
	now        func() time.Time
}

func NewService(store Repository, media PathManager, portPolicy PortPolicy, srt SRTListenerManager, control *controlplane.Coordinator) *Service {
	if control == nil {
		control = controlplane.NewCoordinator()
	}
	return &Service{store: store, media: media, portPolicy: portPolicy, srt: srt, control: control, now: time.Now}
}

func (s *Service) List(ctx context.Context) ([]Channel, error) {
	return s.store.List(ctx)
}

func (s *Service) Get(ctx context.Context, id string) (Channel, error) {
	if number, err := strconv.Atoi(id); err == nil && number > 0 {
		return s.store.GetByNumber(ctx, number)
	}
	return s.store.Get(ctx, id)
}

func (s *Service) Create(ctx context.Context, draft Draft) (Channel, error) {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return Channel{}, err
	}
	defer release()

	draft, err = resolvePassphrase(draft, nil)
	if err != nil {
		return Channel{}, err
	}
	draft, err = ValidateDraft(draft)
	if err != nil {
		return Channel{}, err
	}
	if err := s.validateUDPPort(ctx, draft, ""); err != nil {
		return Channel{}, err
	}
	item, err := New(draft, s.now())
	if err != nil {
		return Channel{}, err
	}
	items, err := s.store.List(ctx)
	if err != nil {
		return Channel{}, err
	}
	usedNumbers := make(map[int]bool, len(items))
	for _, existing := range items {
		if existing.Number > 0 {
			usedNumbers[existing.Number] = true
		}
	}
	item.Number = firstAvailableNumber(usedNumbers)
	if err := s.store.Create(ctx, item); err != nil {
		return Channel{}, err
	}
	return s.apply(ctx, item)
}

func (s *Service) Update(ctx context.Context, id string, draft Draft) (Channel, error) {
	return s.update(ctx, id, draft, nil)
}

func (s *Service) UpdateExpected(ctx context.Context, id string, draft Draft, expectedRevision int) (Channel, error) {
	return s.update(ctx, id, draft, &expectedRevision)
}

func (s *Service) update(ctx context.Context, id string, draft Draft, expectedRevision *int) (Channel, error) {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return Channel{}, err
	}
	defer release()

	current, err := s.Get(ctx, id)
	if err != nil {
		return Channel{}, err
	}
	if expectedRevision != nil && current.Revision != *expectedRevision {
		return Channel{}, ErrRevisionConflict
	}
	if current.ApplyState == ApplyDeleting {
		return Channel{}, ErrDeleting
	}
	if draft.PreserveAutomaticPreview {
		draft.AutomaticPreview = current.AutomaticPreview
	}
	if draft.PreserveUseAbsoluteTimestamp {
		draft.UseAbsoluteTimestamp = current.UseAbsoluteTimestamp
	}
	draft, err = resolvePassphrase(draft, &current)
	if err != nil {
		return Channel{}, err
	}
	draft, err = ValidateDraft(draft)
	if err != nil {
		return Channel{}, err
	}
	if err := s.validateUDPPort(ctx, draft, current.ID); err != nil {
		return Channel{}, err
	}
	if sameAppliedConfiguration(current, draft) {
		previousRevision := current.Revision
		current.AutomaticPreview = draft.AutomaticPreview
		current.Revision++
		current.UpdatedAt = s.now().UTC()
		if err := s.store.Update(ctx, current, previousRevision); err != nil {
			return Channel{}, err
		}
		return current, nil
	}
	item, err := current.WithDraft(draft, s.now())
	if err != nil {
		return Channel{}, err
	}
	previousRevision := item.Revision
	item.Revision++
	if err := s.store.Update(ctx, item, previousRevision); err != nil {
		return Channel{}, err
	}
	return s.apply(ctx, item)
}

func (s *Service) UpdateAutomaticPreview(ctx context.Context, id string, automaticPreview bool, expectedRevision *int) (Channel, error) {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return Channel{}, err
	}
	defer release()

	current, err := s.Get(ctx, id)
	if err != nil {
		return Channel{}, err
	}
	if expectedRevision != nil && current.Revision != *expectedRevision {
		return Channel{}, ErrRevisionConflict
	}
	if current.ApplyState == ApplyDeleting {
		return Channel{}, ErrDeleting
	}
	if err := s.store.UpdateAutomaticPreview(ctx, current.ID, automaticPreview, s.now().UTC(), current.Revision); err != nil {
		return Channel{}, err
	}
	return s.store.Get(ctx, current.ID)
}

func resolvePassphrase(draft Draft, current *Channel) (Draft, error) {
	if draft.Input.SRT == nil {
		if draft.PassphraseIntent == PassphraseSet || draft.PassphraseIntent == PassphraseClear {
			return Draft{}, invalid("passphrase intent requires SRT input settings")
		}
		return draft, nil
	}
	switch draft.PassphraseIntent {
	case PassphraseUnspecified, PassphraseSet:
	case PassphraseKeep:
		draft.Input.SRT.Passphrase = ""
		if current != nil && current.Input.SRT != nil {
			draft.Input.SRT.Passphrase = current.Input.SRT.Passphrase
		}
	case PassphraseClear:
		draft.Input.SRT.Passphrase = ""
	default:
		return Draft{}, invalid("unsupported passphrase intent")
	}
	return draft, nil
}

func sameAppliedConfiguration(current Channel, draft Draft) bool {
	return current.Name == draft.Name &&
		current.Enabled == draft.Enabled &&
		reflect.DeepEqual(current.Input, draft.Input) &&
		current.MaxReaders == draft.MaxReaders &&
		current.UseAbsoluteTimestamp == draft.UseAbsoluteTimestamp
}

func (s *Service) validateUDPPort(ctx context.Context, draft Draft, excludeID string) error {
	isRTP := draft.Input.Mode == InputRTPUnicast || draft.Input.Mode == InputRTPMulticast
	isSRTPush := draft.Input.Mode == InputSRTPush
	if !isRTP && !isSRTPush {
		return nil
	}
	port := 0
	if isRTP {
		port = draft.Input.RTP.Port
	} else {
		port = draft.Input.SRT.Port
	}
	if s.portPolicy != nil {
		minimum, maximum, _, _, reserved, err := s.portPolicy.MediaPolicy(ctx)
		if err != nil {
			return err
		}
		if isRTP && (port < minimum || port > maximum) {
			return fmt.Errorf("%w: RTP port must be inside the configured range %d-%d", ErrInvalid, minimum, maximum)
		}
		if isSRTPush && port >= minimum && port <= maximum {
			return fmt.Errorf("%w: SRT push listener port cannot be inside the configured RTP range %d-%d", ErrInvalid, minimum, maximum)
		}
		for _, reservedPort := range reserved {
			if port == reservedPort {
				return fmt.Errorf("%w: UDP port %d is reserved by a global media listener", ErrInvalid, port)
			}
		}
	}
	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.ID == excludeID {
			continue
		}
		usedPort := 0
		if item.Input.RTP != nil {
			usedPort = item.Input.RTP.Port
		} else if item.Input.Mode == InputSRTPush && item.Input.SRT != nil {
			usedPort = item.Input.SRT.Port
		}
		if usedPort == port {
			return fmt.Errorf("%w: UDP port %d is already assigned to %s", ErrInvalid, port, item.Name)
		}
	}
	return nil
}

func (s *Service) ValidatePortPolicy(ctx context.Context, minimum, maximum int, reserved []int) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.Input.RTP != nil {
			port := item.Input.RTP.Port
			if port < minimum || port > maximum {
				return fmt.Errorf("%w: RTP port range must include port %d used by %s", ErrInvalid, port, item.Name)
			}
			continue
		}
		if item.Input.Mode != InputSRTPush || item.Input.SRT == nil {
			continue
		}
		port := item.Input.SRT.Port
		if port >= minimum && port <= maximum {
			return fmt.Errorf("%w: RTP port range cannot include SRT listener port %d used by %s", ErrInvalid, port, item.Name)
		}
		for _, reservedPort := range reserved {
			if port == reservedPort {
				return fmt.Errorf("%w: global UDP listeners cannot use SRT listener port %d assigned to %s", ErrInvalid, port, item.Name)
			}
		}
	}
	return nil
}

func (s *Service) Delete(ctx context.Context, id string) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	item, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	if item.ApplyState != ApplyDeleting {
		previousRevision := item.Revision
		item.Enabled = false
		item.ApplyState = ApplyDeleting
		item.ApplyError = ""
		item.Revision++
		item.UpdatedAt = s.now().UTC()
		if err := s.store.Update(ctx, item, previousRevision); err != nil {
			return err
		}
	}
	return s.finishDelete(ctx, item)
}

func (s *Service) finishDelete(ctx context.Context, item Channel) error {
	var relayErr error
	if s.srt != nil {
		relayErr = s.srt.Stop(ctx, item.ID)
	}
	mediaErr := s.media.DeletePath(ctx, item.Path)
	cleanupErr := errors.Join(relayErr, errorWithPrefix("remove MediaMTX path", mediaErr))
	if cleanupErr != nil {
		_ = s.store.SetApplyResult(ctx, item.ID, item.Revision, ApplyDeleting, cleanupErr.Error())
		return errors.Join(ErrDeleting, cleanupErr)
	}
	if err := s.store.Delete(ctx, item.ID, item.Revision); err != nil {
		_ = s.store.SetApplyResult(ctx, item.ID, item.Revision, ApplyDeleting, err.Error())
		return errors.Join(ErrDeleting, err)
	}
	return nil
}

func errorWithPrefix(prefix string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", prefix, err)
}

func (s *Service) Reconcile(ctx context.Context) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}

	return s.reconcileWithMedia(ctx, items, "", "")
}

func (s *Service) ReconcileMedia(ctx context.Context, mediaBind, srtAddress string) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}
	return s.reconcileWithMedia(ctx, items, mediaBind, srtAddress)
}

func (s *Service) reconcileWithMedia(ctx context.Context, items []Channel, mediaBind, srtAddress string) error {
	var failures []error
	for _, item := range items {
		if item.ApplyState == ApplyDeleting {
			if err := s.finishDelete(ctx, item); err != nil {
				failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
			}
			continue
		}
		var err error
		if mediaBind == "" {
			_, err = s.apply(ctx, item)
		} else {
			_, err = s.applyWithMedia(ctx, item, mediaBind, srtAddress)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) ReconcilePending(ctx context.Context) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}

	var failures []error
	for _, item := range items {
		if item.ApplyState == ApplyDeleting {
			if err := s.finishDelete(ctx, item); err != nil {
				failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
			}
			continue
		}
		if item.ApplyState == ApplyApplied {
			continue
		}
		if _, err := s.apply(ctx, item); err != nil {
			failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) ReconcileSRTListeners(ctx context.Context) error {
	ctx, release, err := s.control.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, item := range items {
		if item.ApplyState == ApplyDeleting {
			if err := s.finishDelete(ctx, item); err != nil {
				failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
			}
			continue
		}
		if err := s.applySRTListener(ctx, item); err != nil {
			failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) apply(ctx context.Context, item Channel) (Channel, error) {
	if !item.Enabled {
		return s.applyWithMedia(ctx, item, networkbind.Custom, "")
	}
	mediaBind := networkbind.Custom
	srtAddress := ""
	var err error
	if s.portPolicy != nil {
		_, _, srtAddress, mediaBind, _, err = s.portPolicy.MediaPolicy(ctx)
	}
	if err != nil {
		return s.applyResult(ctx, item, err)
	}
	return s.applyWithMedia(ctx, item, mediaBind, srtAddress)
}

func (s *Service) applyWithMedia(ctx context.Context, item Channel, mediaBind, srtAddress string) (Channel, error) {
	var applyErr error
	if item.Enabled {
		if !isSRTMode(item.Input.Mode) && s.srt != nil {
			applyErr = errors.Join(applyErr, s.srt.Stop(ctx, item.ID))
		}
		var ingestPlan *SRTIngestPlan
		if applyErr == nil && isSRTMode(item.Input.Mode) && s.srt != nil {
			plan, err := s.prepareSRTIngest(ctx, item, mediaBind, srtAddress)
			applyErr = errors.Join(applyErr, err)
			ingestPlan = &plan
		}
		if applyErr == nil {
			config := pathConfig(item, mediaBind)
			if ingestPlan != nil {
				config.Source = ingestPlan.Source
				config.RTPSDP = ingestPlan.RTPSDP
				config.SRTPublishPassphrase = ingestPlan.PublishPassphrase
			}
			applyErr = s.media.ReplacePath(ctx, item.Path, config)
		}
		if applyErr == nil && ingestPlan != nil {
			applyErr = s.srt.Ensure(ctx, *ingestPlan)
		}
	} else {
		if s.srt != nil {
			applyErr = s.srt.Stop(ctx, item.ID)
		}
		applyErr = errors.Join(applyErr, s.media.DeletePath(ctx, item.Path))
	}

	return s.applyResult(ctx, item, applyErr)
}

func (s *Service) applyResult(ctx context.Context, item Channel, applyErr error) (Channel, error) {
	if applyErr != nil {
		item.ApplyState = ApplyError
		item.ApplyError = applyErr.Error()
		if err := s.store.SetApplyResult(ctx, item.ID, item.Revision, item.ApplyState, item.ApplyError); err != nil {
			return item, errors.Join(applyErr, err)
		}
		return item, applyErr
	}

	item.ApplyState = ApplyApplied
	item.ApplyError = ""
	if err := s.store.SetApplyResult(ctx, item.ID, item.Revision, item.ApplyState, ""); err != nil {
		return item, err
	}
	return item, nil
}

func (s *Service) applySRTListener(ctx context.Context, item Channel) error {
	mediaBind := networkbind.Custom
	srtAddress := ""
	if s.portPolicy != nil {
		var err error
		_, _, srtAddress, mediaBind, _, err = s.portPolicy.MediaPolicy(ctx)
		if err != nil {
			return err
		}
	}
	return s.applySRTListenerWithBind(ctx, item, mediaBind, srtAddress)
}

func (s *Service) applySRTListenerWithBind(ctx context.Context, item Channel, mediaBind, srtAddress string) error {
	if s.srt == nil {
		return nil
	}
	if !item.Enabled || !isSRTMode(item.Input.Mode) {
		return s.srt.Stop(ctx, item.ID)
	}
	plan, err := s.prepareSRTIngest(ctx, item, mediaBind, srtAddress)
	if err != nil {
		return err
	}
	return s.srt.Ensure(ctx, plan)
}

func (s *Service) prepareSRTIngest(ctx context.Context, item Channel, mediaBind, destination string) (SRTIngestPlan, error) {
	if s.portPolicy == nil {
		return SRTIngestPlan{}, errors.New("SRT ingest destination is unavailable")
	}
	srt := item.Input.SRT
	return s.srt.Prepare(ctx, SRTListener{
		ChannelID:          item.ID,
		Path:               item.Path,
		Mode:               item.Input.Mode,
		BindAddress:        networkbind.Host(mediaBind),
		Port:               srt.Port,
		Host:               srt.Host,
		StreamID:           srt.StreamID,
		LatencyMS:          srt.LatencyMS,
		SDP:                srt.SDP,
		DestinationAddress: destination,
		Passphrase:         srt.Passphrase,
	})
}

func isSRTMode(mode InputMode) bool {
	return mode == InputSRTPush || mode == InputSRTPull
}

func pathConfig(item Channel, mediaBind string) mediamtx.PathConfig {
	config := mediamtx.PathConfig{
		MaxReaders:           item.MaxReaders,
		UseAbsoluteTimestamp: item.UseAbsoluteTimestamp,
	}

	switch item.Input.Mode {
	case InputRTPUnicast, InputRTPMulticast:
		rtp := item.Input.RTP
		address := rtp.Address
		if item.Input.Mode == InputRTPUnicast && mediaBind != networkbind.Custom {
			address = networkbind.Host(mediaBind)
		}
		source := &url.URL{
			Scheme: "udp+rtp",
			Host:   net.JoinHostPort(address, strconv.Itoa(rtp.Port)),
		}
		query := source.Query()
		if rtp.Interface != "" {
			query.Set("interface", rtp.Interface)
		}
		if rtp.SourceIP != "" {
			query.Set("source", rtp.SourceIP)
		}
		source.RawQuery = query.Encode()
		config.Source = source.String()
		config.RTPSDP = rtp.SDP

	case InputSRTPush:
		config.Source = "publisher"
		config.SRTPublishPassphrase = item.Input.SRT.Passphrase

	case InputSRTPull:
		srt := item.Input.SRT
		source := &url.URL{
			Scheme: "srt",
			Host:   net.JoinHostPort(srt.Host, strconv.Itoa(srt.Port)),
		}
		query := source.Query()
		if srt.StreamID != "" {
			query.Set("streamid", srt.StreamID)
		}
		if srt.Passphrase != "" {
			query.Set("passphrase", srt.Passphrase)
		}
		if srt.LatencyMS > 0 {
			query.Set("latency", strconv.Itoa(srt.LatencyMS))
		}
		source.RawQuery = query.Encode()
		config.Source = source.String()
	}

	return config
}
