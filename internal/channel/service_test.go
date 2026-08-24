package channel

import (
	"context"
	"errors"
	"net/url"
	"path/filepath"
	"sync"
	"testing"

	"webrtc-gateway/internal/mediamtx"
)

type fakePathManager struct {
	replacedName   string
	replacedConfig mediamtx.PathConfig
	replacements   int
	deletedName    string
	err            error
}

type fakeRTPPolicy struct {
	minimum    int
	maximum    int
	srtAddress string
	reserved   []int
	mediaBind  string
}

func (f fakeRTPPolicy) MediaPolicy(context.Context) (int, int, string, string, []int, error) {
	mediaBind := f.mediaBind
	if mediaBind == "" {
		mediaBind = "custom"
	}
	return f.minimum, f.maximum, f.srtAddress, mediaBind, f.reserved, nil
}

type fakeSRTListenerManager struct {
	prepared SRTListener
	ensured  SRTListener
	stopped  string
	err      error
}

type destinationSRTListenerManager struct{}

func (destinationSRTListenerManager) Prepare(_ context.Context, listener SRTListener) (SRTIngestPlan, error) {
	plan := SRTIngestPlan{Listener: listener, Source: "publisher", PublishPassphrase: listener.DestinationAddress}
	if listener.SDP != "" {
		plan.Source = "udp+rtp://127.0.0.1" + listener.DestinationAddress
		plan.RTPSDP = listener.SDP
		plan.PublishPassphrase = ""
	}
	return plan, nil
}

func (destinationSRTListenerManager) Ensure(context.Context, SRTIngestPlan) error { return nil }
func (destinationSRTListenerManager) Stop(context.Context, string) error          { return nil }

func (f *fakeSRTListenerManager) Prepare(_ context.Context, listener SRTListener) (SRTIngestPlan, error) {
	f.prepared = listener
	if listener.SDP != "" {
		return SRTIngestPlan{
			Listener: listener, Source: "udp+rtp://127.0.0.1:30000?source=127.0.0.1", RTPSDP: listener.SDP,
		}, f.err
	}
	return SRTIngestPlan{
		Listener: listener, Source: "publisher", PublishPassphrase: listener.Passphrase,
	}, f.err
}

func TestServiceConfiguresElementaryRTPOverSRTSource(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	media := &fakePathManager{}
	relay := &fakeSRTListenerManager{}
	service := NewService(store, media, fakeRTPPolicy{
		minimum: 22000, maximum: 22999, srtAddress: "192.0.2.20:8890", mediaBind: "192.0.2.20",
	}, relay, nil)
	sdp := "v=0\nm=video 0 RTP/AVP 96\na=rtpmap:96 H264/90000"
	item, err := service.Create(context.Background(), Draft{
		Name: "Elementary RTP tunnel", Enabled: true,
		Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 10000, SDP: sdp}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if relay.ensured.ChannelID != item.ID || relay.ensured.SDP != sdp {
		t.Fatalf("relay plan = %#v", relay.ensured)
	}
	if media.replacedConfig.Source != "udp+rtp://127.0.0.1:30000?source=127.0.0.1" || media.replacedConfig.RTPSDP != sdp || media.replacedConfig.SRTPublishPassphrase != "" {
		t.Fatalf("MediaMTX path = %#v", media.replacedConfig)
	}
}

func TestServiceAssignsLowestAvailableChannelNumber(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service := NewService(store, &fakePathManager{}, nil, nil, nil)
	create := func(name string, port int) Channel {
		item, err := service.Create(context.Background(), Draft{
			Name: name, Enabled: true,
			Input: Input{Mode: InputSRTPull, SRT: &SRTInput{Host: "source.local", Port: port}},
		})
		if err != nil {
			t.Fatalf("Create(%q) error = %v", name, err)
		}
		return item
	}

	first := create("First", 9001)
	second := create("Second", 9002)
	third := create("Third", 9003)
	if first.Number != 1 || second.Number != 2 || third.Number != 3 {
		t.Fatalf("initial channel numbers = %d, %d, %d", first.Number, second.Number, third.Number)
	}
	updated, err := service.Update(context.Background(), "2", Draft{
		Name: "Second renamed", Enabled: true,
		Input: Input{Mode: InputSRTPull, SRT: &SRTInput{Host: "source.local", Port: 9002}},
	})
	if err != nil || updated.ID != second.ID || updated.Number != 2 {
		t.Fatalf("Update(2) = %#v, %v", updated, err)
	}
	if err := service.Delete(context.Background(), "2"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	replacement := create("Replacement", 9004)
	if replacement.Number != 2 {
		t.Fatalf("replacement channel number = %d, want 2", replacement.Number)
	}
	resolved, err := service.Get(context.Background(), "2")
	if err != nil || resolved.ID != replacement.ID {
		t.Fatalf("Get(2) = %#v, %v", resolved, err)
	}
}

func TestFullReconcileRefreshesSRTDestinationDependentPath(t *testing.T) {
	for name, sdp := range map[string]string{
		"raw pull":   "",
		"elementary": "v=0\nm=video 0 RTP/AVP 96\na=rtpmap:96 H264/90000",
	} {
		t.Run(name, func(t *testing.T) {
			store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			media := &fakePathManager{}
			policy := &fakeRTPPolicy{minimum: 22000, maximum: 22999, srtAddress: ":8890"}
			service := NewService(store, media, policy, destinationSRTListenerManager{}, nil)
			_, err = service.Create(context.Background(), Draft{
				Name: name, Enabled: true,
				Input: Input{Mode: InputSRTPull, SRT: &SRTInput{Host: "source.local", Port: 9000, SDP: sdp}},
			})
			if err != nil {
				t.Fatal(err)
			}
			policy.srtAddress = ":8891"
			if err := service.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			if sdp == "" && media.replacedConfig.SRTPublishPassphrase != ":8891" {
				t.Fatalf("publish passphrase = %q", media.replacedConfig.SRTPublishPassphrase)
			}
			if sdp != "" && media.replacedConfig.Source != "udp+rtp://127.0.0.1:8891" {
				t.Fatalf("RTP source = %q", media.replacedConfig.Source)
			}
		})
	}
}

func (f *fakeSRTListenerManager) Ensure(_ context.Context, plan SRTIngestPlan) error {
	f.ensured = plan.Listener
	return f.err
}

func (f *fakeSRTListenerManager) Stop(_ context.Context, channelID string) error {
	f.stopped = channelID
	return f.err
}

func (f *fakePathManager) ReplacePath(_ context.Context, name string, config mediamtx.PathConfig) error {
	f.replacedName = name
	f.replacedConfig = config
	f.replacements++
	return f.err
}

func TestServiceUpdatesAutomaticPreviewWithoutReapplyingMedia(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	media := &fakePathManager{}
	service := NewService(store, media, nil, nil, nil)
	draft := Draft{
		Name: "Preview preference", Enabled: true,
		Input: Input{Mode: InputSRTPull, SRT: &SRTInput{Host: "source.local", Port: 9000}},
	}
	item, err := service.Create(context.Background(), draft)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if media.replacements != 1 {
		t.Fatalf("initial replacements = %d", media.replacements)
	}
	draft.AutomaticPreview = true
	updated, err := service.Update(context.Background(), item.ID, draft)
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if !updated.AutomaticPreview || media.replacements != 1 {
		t.Fatalf("preview update = %#v, replacements %d", updated, media.replacements)
	}
}

func (f *fakePathManager) DeletePath(_ context.Context, name string) error {
	f.deletedName = name
	return f.err
}

func TestServiceCreatesAndAppliesSRTPull(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	media := &fakePathManager{}
	service := NewService(store, media, nil, nil, nil)

	item, err := service.Create(context.Background(), Draft{
		Name:    "Remote SRT",
		Enabled: true,
		Input: Input{Mode: InputSRTPull, SRT: &SRTInput{
			Host: "source.local", Port: 9000, StreamID: "camera one", Passphrase: "test+secret", LatencyMS: 200,
		}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if item.ApplyState != ApplyApplied || media.replacedName != item.Path {
		t.Fatalf("channel was not applied: %#v, path %q", item, media.replacedName)
	}
	source, err := url.Parse(media.replacedConfig.Source)
	if err != nil {
		t.Fatalf("parse source URL: %v", err)
	}
	if source.Query().Get("passphrase") != "test+secret" || source.Query().Get("streamid") != "camera one" || source.Query().Get("latency") != "200" {
		t.Fatalf("unexpected SRT source query: %q", source.RawQuery)
	}
}

func TestServicePersistsApplyFailureForRetry(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	media := &fakePathManager{err: errors.New("offline")}
	service := NewService(store, media, nil, nil, nil)

	item, err := service.Create(context.Background(), Draft{
		Name: "SRT push", Enabled: true,
		Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 10000}},
	})
	if err == nil || item.ApplyState != ApplyError {
		t.Fatalf("Create() = %#v, %v; want apply error", item, err)
	}
	persisted, getErr := store.Get(context.Background(), item.ID)
	if getErr != nil || persisted.ApplyState != ApplyError || persisted.ApplyError == "" {
		t.Fatalf("persisted apply state = %#v, %v", persisted, getErr)
	}

	media.err = nil
	if err := service.ReconcilePending(context.Background()); err != nil {
		t.Fatalf("ReconcilePending() error = %v", err)
	}
	persisted, _ = store.Get(context.Background(), item.ID)
	if persisted.ApplyState != ApplyApplied {
		t.Fatalf("ApplyState = %q, want applied", persisted.ApplyState)
	}
}

func TestServiceRetriesPartiallyFailedDelete(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	media := &fakePathManager{}
	service := NewService(store, media, nil, nil, nil)
	item, err := service.Create(context.Background(), Draft{
		Name: "Delete retry", Enabled: true,
		Input: Input{Mode: InputSRTPull, SRT: &SRTInput{Host: "source.local", Port: 9000}},
	})
	if err != nil {
		t.Fatal(err)
	}

	media.err = errors.New("offline")
	if err := service.Delete(context.Background(), item.ID); !errors.Is(err, ErrDeleting) {
		t.Fatalf("Delete() error = %v", err)
	}
	persisted, err := service.Get(context.Background(), item.ID)
	if err != nil || persisted.Enabled || persisted.ApplyState != ApplyDeleting || persisted.ApplyError == "" {
		t.Fatalf("deleting channel = %#v, %v", persisted, err)
	}
	if _, err := service.Update(context.Background(), item.ID, Draft{}); !errors.Is(err, ErrDeleting) {
		t.Fatalf("Update() error = %v", err)
	}

	media.err = nil
	if err := service.ReconcilePending(context.Background()); err != nil {
		t.Fatalf("ReconcilePending() error = %v", err)
	}
	if _, err := service.Get(context.Background(), item.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() error = %v, want not found", err)
	}
}

func TestServiceEnforcesRTPPortPolicy(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	service := NewService(store, &fakePathManager{}, fakeRTPPolicy{minimum: 22000, maximum: 22010}, nil, nil)

	draft := Draft{
		Name: "RTP one", Enabled: true,
		Input: Input{Mode: InputRTPUnicast, RTP: &RTPInput{
			Address: "0.0.0.0", Port: 21999, SDP: "v=0\nm=video 21999 RTP/AVP 96",
		}},
	}
	if _, err := service.Create(context.Background(), draft); !errors.Is(err, ErrInvalid) {
		t.Fatalf("out-of-range Create() error = %v", err)
	}

	draft.Input.RTP.Port = 22000
	draft.Input.RTP.SDP = "v=0\nm=video 22000 RTP/AVP 96"
	if _, err := service.Create(context.Background(), draft); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	draft.Name = "RTP two"
	if _, err := service.Create(context.Background(), draft); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate-port Create() error = %v", err)
	}
}

func TestServiceStartsPerChannelSRTPushListener(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	relay := &fakeSRTListenerManager{}
	service := NewService(store, &fakePathManager{}, fakeRTPPolicy{
		minimum: 22000, maximum: 22999, srtAddress: "192.0.2.20:8890", reserved: []int{8890, 8189}, mediaBind: "192.0.2.20",
	}, relay, nil)

	item, err := service.Create(context.Background(), Draft{
		Name: "Port-only sender", Enabled: true,
		Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 10000, Passphrase: "0123456789"}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if relay.ensured.ChannelID != item.ID || relay.ensured.Port != 10000 || relay.ensured.BindAddress != "192.0.2.20" || relay.ensured.LatencyMS != DefaultSRTLatencyMS || relay.ensured.DestinationAddress != "192.0.2.20:8890" {
		t.Fatalf("relay listener = %#v", relay.ensured)
	}
	if relay.ensured.Passphrase != "0123456789" {
		t.Fatal("relay passphrase was not preserved")
	}
}

func TestServiceAppliesGlobalBindingToRTPUnicast(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	media := &fakePathManager{}
	service := NewService(store, media, fakeRTPPolicy{
		minimum: 22000, maximum: 22999, mediaBind: "192.0.2.30",
	}, nil, nil)
	_, err = service.Create(context.Background(), Draft{
		Name: "RTP camera", Enabled: true,
		Input: Input{Mode: InputRTPUnicast, RTP: &RTPInput{
			Address: "0.0.0.0", Port: 22000, SDP: "v=0\nm=video 22000 RTP/AVP 96",
		}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	source, err := url.Parse(media.replacedConfig.Source)
	if err != nil {
		t.Fatal(err)
	}
	if source.Hostname() != "192.0.2.30" || source.Port() != "22000" {
		t.Fatalf("RTP source = %q", media.replacedConfig.Source)
	}
}

func TestServiceRejectsConflictingSRTPushPorts(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	service := NewService(store, &fakePathManager{}, fakeRTPPolicy{
		minimum: 22000, maximum: 22999, srtAddress: ":8890", reserved: []int{8890, 8189},
	}, &fakeSRTListenerManager{}, nil)
	draft := Draft{Name: "SRT one", Enabled: true, Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 22000}}}
	if _, err := service.Create(context.Background(), draft); !errors.Is(err, ErrInvalid) {
		t.Fatalf("RTP-range Create() error = %v", err)
	}
	draft.Input.SRT.Port = 8890
	if _, err := service.Create(context.Background(), draft); !errors.Is(err, ErrInvalid) {
		t.Fatalf("reserved-port Create() error = %v", err)
	}
	draft.Input.SRT.Port = 10000
	if _, err := service.Create(context.Background(), draft); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	draft.Name = "SRT two"
	if _, err := service.Create(context.Background(), draft); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate-port Create() error = %v", err)
	}
}

func TestServiceSerializesConcurrentPortAllocation(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service := NewService(store, &fakePathManager{}, fakeRTPPolicy{
		minimum: 22000, maximum: 22999, reserved: []int{8890, 8189},
	}, &fakeSRTListenerManager{}, nil)
	start := make(chan struct{})
	errorsSeen := make(chan error, 2)
	var wait sync.WaitGroup
	for _, name := range []string{"First", "Second"} {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, err := service.Create(context.Background(), Draft{
				Name: name, Enabled: true,
				Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 10000}},
			})
			errorsSeen <- err
		}()
	}
	close(start)
	wait.Wait()
	close(errorsSeen)

	succeeded, rejected := 0, 0
	for err := range errorsSeen {
		if err == nil {
			succeeded++
		} else if errors.Is(err, ErrInvalid) {
			rejected++
		} else {
			t.Fatalf("Create() error = %v", err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("create results = %d succeeded, %d rejected", succeeded, rejected)
	}
}
