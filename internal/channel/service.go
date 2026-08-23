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

	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
)

type PathManager interface {
	ReplacePath(context.Context, string, mediamtx.PathConfig) error
	DeletePath(context.Context, string) error
}

type PortPolicy interface {
	ChannelPortPolicy(context.Context) (rtpMinimum, rtpMaximum int, srtAddress string, reservedUDPPorts []int, err error)
	MediaBindAddress(context.Context) (string, error)
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
	now        func() time.Time
}

func NewService(store Repository, media PathManager, portPolicy PortPolicy, srt SRTListenerManager) *Service {
	return &Service{store: store, media: media, portPolicy: portPolicy, srt: srt, now: time.Now}
}

func (s *Service) List(ctx context.Context) ([]Channel, error) {
	return s.store.List(ctx)
}

func (s *Service) Get(ctx context.Context, id string) (Channel, error) {
	return s.store.Get(ctx, id)
}

func (s *Service) Create(ctx context.Context, draft Draft) (Channel, error) {
	var err error
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
	if err := s.store.Create(ctx, item); err != nil {
		return Channel{}, err
	}
	return s.apply(ctx, item)
}

func (s *Service) Update(ctx context.Context, id string, draft Draft) (Channel, error) {
	current, err := s.store.Get(ctx, id)
	if err != nil {
		return Channel{}, err
	}
	draft, err = ValidateDraft(draft)
	if err != nil {
		return Channel{}, err
	}
	if err := s.validateUDPPort(ctx, draft, id); err != nil {
		return Channel{}, err
	}
	if sameAppliedConfiguration(current, draft) {
		current.AutomaticPreview = draft.AutomaticPreview
		current.UpdatedAt = s.now().UTC()
		if err := s.store.Update(ctx, current); err != nil {
			return Channel{}, err
		}
		return current, nil
	}
	item, err := current.WithDraft(draft, s.now())
	if err != nil {
		return Channel{}, err
	}
	if err := s.store.Update(ctx, item); err != nil {
		return Channel{}, err
	}
	return s.apply(ctx, item)
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
		minimum, maximum, _, reserved, err := s.portPolicy.ChannelPortPolicy(ctx)
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

func (s *Service) Delete(ctx context.Context, id string) error {
	item, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	var relayErr error
	if s.srt != nil {
		relayErr = s.srt.Stop(ctx, item.ID)
	}
	if err := s.media.DeletePath(ctx, item.Path); err != nil {
		return errors.Join(relayErr, fmt.Errorf("remove MediaMTX path: %w", err))
	}
	return errors.Join(relayErr, s.store.Delete(ctx, id))
}

func (s *Service) Reconcile(ctx context.Context) error {
	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}

	var failures []error
	for _, item := range items {
		if _, err := s.apply(ctx, item); err != nil {
			failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) ReconcilePending(ctx context.Context) error {
	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}

	var failures []error
	for _, item := range items {
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
	items, err := s.store.List(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for _, item := range items {
		if err := s.applySRTListener(ctx, item); err != nil {
			failures = append(failures, fmt.Errorf("channel %s: %w", item.ID, err))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) apply(ctx context.Context, item Channel) (Channel, error) {
	var applyErr error
	if item.Enabled {
		mediaBind := networkbind.Custom
		if s.portPolicy != nil {
			mediaBind, applyErr = s.portPolicy.MediaBindAddress(ctx)
		}
		if !isSRTMode(item.Input.Mode) && s.srt != nil {
			applyErr = errors.Join(applyErr, s.srt.Stop(ctx, item.ID))
		}
		var ingestPlan *SRTIngestPlan
		if applyErr == nil && isSRTMode(item.Input.Mode) && s.srt != nil {
			plan, err := s.prepareSRTIngest(ctx, item, mediaBind)
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

	if applyErr != nil {
		item.ApplyState = ApplyError
		item.ApplyError = applyErr.Error()
		if err := s.store.SetApplyResult(ctx, item.ID, item.ApplyState, item.ApplyError); err != nil {
			return item, errors.Join(applyErr, err)
		}
		return item, applyErr
	}

	item.ApplyState = ApplyApplied
	item.ApplyError = ""
	if err := s.store.SetApplyResult(ctx, item.ID, item.ApplyState, ""); err != nil {
		return item, err
	}
	return item, nil
}

func (s *Service) applySRTListener(ctx context.Context, item Channel) error {
	mediaBind := networkbind.Custom
	if s.portPolicy != nil {
		var err error
		mediaBind, err = s.portPolicy.MediaBindAddress(ctx)
		if err != nil {
			return err
		}
	}
	return s.applySRTListenerWithBind(ctx, item, mediaBind)
}

func (s *Service) applySRTListenerWithBind(ctx context.Context, item Channel, mediaBind string) error {
	if s.srt == nil {
		return nil
	}
	if !item.Enabled || !isSRTMode(item.Input.Mode) {
		return s.srt.Stop(ctx, item.ID)
	}
	plan, err := s.prepareSRTIngest(ctx, item, mediaBind)
	if err != nil {
		return err
	}
	return s.srt.Ensure(ctx, plan)
}

func (s *Service) prepareSRTIngest(ctx context.Context, item Channel, mediaBind string) (SRTIngestPlan, error) {
	if s.portPolicy == nil {
		return SRTIngestPlan{}, errors.New("SRT ingest destination is unavailable")
	}
	_, _, destination, _, err := s.portPolicy.ChannelPortPolicy(ctx)
	if err != nil {
		return SRTIngestPlan{}, err
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
