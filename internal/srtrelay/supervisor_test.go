package srtrelay

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"webrtc-gateway/internal/channel"
)

func TestBuildInputEndpointUsesWiredLANDefaults(t *testing.T) {
	config := channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		BindAddress: "192.0.2.20", Port: 10000, DestinationAddress: ":8890", Passphrase: "0123456789",
	}
	inputValue, err := buildInputEndpoint(config)
	if err != nil {
		t.Fatalf("buildInputEndpoint() error = %v", err)
	}
	input, _ := url.Parse(inputValue)
	if input.Hostname() != "192.0.2.20" || input.Port() != "10000" || input.Query().Get("mode") != "listener" || input.Query().Has("streamid") {
		t.Fatalf("input URL = %q", input.String())
	}
	if input.Query().Get("passphrase") != "0123456789" || input.Query().Get("latency") != "60" ||
		input.Query().Get("rcvbuf") != "4194304" || input.Query().Get("conntimeo") != "1000" || input.Query().Get("peeridletimeo") != "3000" {
		t.Fatalf("input URL options = %q", input.RawQuery)
	}
	outputValue, err := buildPublishEndpoint(config, config.Passphrase)
	if err != nil {
		t.Fatal(err)
	}
	output, _ := url.Parse(outputValue)
	if output.Hostname() != "127.0.0.1" || output.Port() != "8890" || output.Query().Get("streamid") != "publish:studio-camera" ||
		output.Query().Get("passphrase") != "0123456789" || output.Query().Get("latency") != "60" || output.Query().Get("sndbuf") != "4194304" {
		t.Fatalf("output URL = %q", output.String())
	}
}

func TestPrepareSelectsPublisherForAutomaticTSPayloads(t *testing.T) {
	supervisor := newTestSupervisor(t, "srt-live-transmit")
	t.Cleanup(func() { _ = supervisor.Close() })
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		Port: 10000, DestinationAddress: ":8890", Passphrase: "0123456789",
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if plan.Source != "publisher" || plan.RTPSDP != "" || plan.PublishPassphrase != "0123456789" || !strings.Contains(plan.OutputAddress, "streamid=publish:studio-camera") {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestPrepareSelectsLoopbackRTPSourceForElementarySDP(t *testing.T) {
	supervisor := newTestSupervisor(t, "srt-live-transmit")
	t.Cleanup(func() { _ = supervisor.Close() })
	sdp := "v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n"
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		Port: 10000, SDP: sdp,
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	source, err := url.Parse(plan.Source)
	if err != nil || source.Scheme != "udp+rtp" || source.Hostname() != "127.0.0.1" || source.Port() == "" || source.Query().Get("source") != "127.0.0.1" {
		t.Fatalf("source = %q, %v", plan.Source, err)
	}
	if plan.RTPSDP != sdp || plan.OutputAddress == "" || plan.PublishPassphrase != "" {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestPrepareUsesInternalPublishSecretForPull(t *testing.T) {
	supervisor := newTestSupervisor(t, "srt-live-transmit")
	t.Cleanup(func() { _ = supervisor.Close() })
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPull,
		Host: "encoder.example", Port: 9000, DestinationAddress: ":8890", Passphrase: "encoder-secret",
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
	if plan.Source != "publisher" || len(plan.PublishPassphrase) < 10 || plan.PublishPassphrase == "encoder-secret" {
		t.Fatalf("plan = %#v", plan)
	}
	if !strings.Contains(plan.OutputAddress, "passphrase="+plan.PublishPassphrase) {
		t.Fatalf("output endpoint does not contain internal passphrase: %q", plan.OutputAddress)
	}
}

func TestParseRTPHandlesCSRCHeaderExtensionAndPadding(t *testing.T) {
	packet := []byte{
		0xb1, 0xa1, 0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 2,
		0, 0, 0, 3,
		0xbe, 0xde, 0, 1, 1, 2, 3, 4,
		0x47, 0, 0, 0, 0, 0, 0, 4,
	}
	parsed, err := parseRTP(packet)
	if err != nil {
		t.Fatalf("parseRTP() error = %v", err)
	}
	if parsed.payloadType != 33 || parsed.sequence != 0x1234 || parsed.timestamp != 1 || parsed.ssrc != 2 || len(parsed.payload) != 4 || parsed.payload[0] != 0x47 {
		t.Fatalf("packet = %#v", parsed)
	}
}

func TestElementaryPayloadTypesValidatesTunnelContract(t *testing.T) {
	valid := "v=0\nm=video 0 RTP/AVP 96\na=rtpmap:96 H264/90000\nm=audio 0 RTP/AVP 97\na=rtpmap:97 opus/48000/2\n"
	allowed, err := elementaryPayloadTypes(valid)
	if err != nil || !allowed[96] || !allowed[97] {
		t.Fatalf("elementaryPayloadTypes() = %#v, %v", allowed, err)
	}
	for name, sdp := range map[string]string{
		"missing mapping": "v=0\nm=video 0 RTP/AVP 96\n",
		"MP2T":            "v=0\nm=video 0 RTP/AVP 33\na=rtpmap:33 MP2T/90000\n",
		"ambiguous RTCP":  "v=0\nm=audio 0 RTP/AVP 72\n",
		"multiple PTs":    "v=0\nm=video 0 RTP/AVP 96 97\na=rtpmap:96 H264/90000\na=rtpmap:97 H265/90000\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := elementaryPayloadTypes(sdp); err == nil {
				t.Fatal("elementaryPayloadTypes() error = nil")
			}
		})
	}
}

func TestFindTSSyncAllowsInitialPartialPacket(t *testing.T) {
	value := append([]byte{1, 2, 3}, make([]byte, 188*3)...)
	value[3], value[3+188], value[3+2*188] = 0x47, 0x47, 0x47
	if got := findTSSync(value); got != 3 {
		t.Fatalf("findTSSync() = %d, want 3", got)
	}
}

func TestPacketReaderPreservesPacketsWithoutSteadyStateDeadlines(t *testing.T) {
	packets := newFakePacketConn()
	packets.reads <- packetRead{data: []byte{1, 2, 3}}
	packets.reads <- packetRead{data: []byte{4, 5}}
	ctx, cancel := context.WithCancel(context.Background())
	reader := newPacketReader(ctx, packets)
	defer reader.close()

	buffer := make([]byte, 16)
	for _, want := range [][]byte{{1, 2, 3}, {4, 5}} {
		got, err := reader.read(buffer)
		if err != nil {
			t.Fatalf("read() error = %v", err)
		}
		if string(got) != string(want) {
			t.Fatalf("read() = %v, want %v", got, want)
		}
	}
	if got := packets.deadlines.Load(); got != 0 {
		t.Fatalf("SetReadDeadline calls before cancellation = %d, want 0", got)
	}

	packets.reads <- packetRead{data: []byte{6, 7, 8}}
	cancel()
	got, err := reader.read(buffer)
	if err != nil || string(got) != string([]byte{6, 7, 8}) {
		t.Fatalf("queued packet after cancellation = %v, %v", got, err)
	}
	if _, err := reader.read(buffer); !errors.Is(err, context.Canceled) {
		t.Fatalf("read() cancellation error = %v", err)
	}
	if got := packets.deadlines.Load(); got != 1 {
		t.Fatalf("SetReadDeadline calls after cancellation = %d, want 1", got)
	}
}

func TestPacketReaderReturnsSocketErrors(t *testing.T) {
	packets := newFakePacketConn()
	want := errors.New("socket failed")
	packets.reads <- packetRead{err: want}
	reader := newPacketReader(context.Background(), packets)
	defer reader.close()

	if _, err := reader.read(make([]byte, 16)); !errors.Is(err, want) {
		t.Fatalf("read() error = %v, want %v", err, want)
	}
	if got := packets.deadlines.Load(); got != 0 {
		t.Fatalf("SetReadDeadline calls = %d, want 0", got)
	}
}

func TestPacketReaderCancellationInterruptsBlockedUDPRead(t *testing.T) {
	packets, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer packets.Close()
	ctx, cancel := context.WithCancel(context.Background())
	reader := newPacketReader(ctx, packets)
	defer reader.close()

	result := make(chan error, 1)
	go func() {
		_, err := reader.read(make([]byte, 16))
		result <- err
	}()
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("read() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked UDP read was not interrupted by cancellation")
	}
}

func TestEnsureReportsMissingExecutable(t *testing.T) {
	supervisor := newTestSupervisor(t, "/missing/srt-live-transmit")
	t.Cleanup(func() { _ = supervisor.Close() })
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		Port: 10000, DestinationAddress: ":8890",
	})
	if err != nil {
		t.Fatal(err)
	}
	err = supervisor.Ensure(context.Background(), plan)
	if err == nil || !strings.Contains(err.Error(), "start SRT channel ingest") {
		t.Fatalf("Ensure() error = %v", err)
	}
}

func TestSupervisorDifferentChannelsStartConcurrently(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		started <- struct{}{}
		<-release
		return inputSession{wait: make(chan error)}, nil
	}
	supervisor.relayFn = blockingRelay

	results := make(chan error, 2)
	go func() { results <- supervisor.Ensure(context.Background(), testPlan("channel-1", 10001)) }()
	waitForSignal(t, started, "first channel startup")
	go func() { results <- supervisor.Ensure(context.Background(), testPlan("channel-2", 10002)) }()
	waitForSignal(t, started, "second channel startup")
	close(release)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorSameChannelEnsuresAreSerialized(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var starts atomic.Int32
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		starts.Add(1)
		started <- struct{}{}
		<-release
		return inputSession{wait: make(chan error)}, nil
	}
	supervisor.relayFn = blockingRelay
	plan := testPlan("channel-1", 10001)

	results := make(chan error, 2)
	go func() { results <- supervisor.Ensure(context.Background(), plan) }()
	waitForSignal(t, started, "first startup")
	go func() { results <- supervisor.Ensure(context.Background(), plan) }()
	waitForActiveOperations(t, supervisor, 2)
	if got := starts.Load(); got != 1 {
		t.Fatalf("start calls while first Ensure is blocked = %d, want 1", got)
	}
	close(release)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if got := starts.Load(); got != 1 {
		t.Fatalf("start calls = %d, want 1", got)
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorEnsureAndStopAreSerialized(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		close(started)
		<-release
		return inputSession{wait: make(chan error)}, nil
	}
	supervisor.relayFn = blockingRelay
	ensureResult := make(chan error, 1)
	go func() { ensureResult <- supervisor.Ensure(context.Background(), testPlan("channel-1", 10001)) }()
	waitForSignal(t, started, "startup")
	stopResult := make(chan error, 1)
	go func() { stopResult <- supervisor.Stop(context.Background(), "channel-1") }()
	waitForActiveOperations(t, supervisor, 2)
	select {
	case err := <-stopResult:
		t.Fatalf("Stop returned before Ensure completed: %v", err)
	default:
	}
	close(release)
	if err := <-ensureResult; err != nil {
		t.Fatal(err)
	}
	if err := <-stopResult; err != nil {
		t.Fatal(err)
	}
	if status := supervisor.Snapshot("channel-1"); status.State != StateStopped {
		t.Fatalf("relay status = %#v", status)
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorQueuedStopHonorsCancellation(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		close(started)
		<-release
		return inputSession{wait: make(chan error)}, nil
	}
	supervisor.relayFn = blockingRelay
	ensureResult := make(chan error, 1)
	go func() { ensureResult <- supervisor.Ensure(context.Background(), testPlan("channel-1", 10001)) }()
	waitForSignal(t, started, "startup")

	ctx, cancel := context.WithCancel(context.Background())
	stopResult := make(chan error, 1)
	go func() { stopResult <- supervisor.Stop(ctx, "channel-1") }()
	waitForActiveOperations(t, supervisor, 2)
	cancel()
	close(release)
	if err := <-ensureResult; err != nil {
		t.Fatal(err)
	}
	if err := <-stopResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("Stop() error = %v, want context canceled", err)
	}
	if status := supervisor.Snapshot("channel-1"); status.State != StateRunning {
		t.Fatalf("relay status = %#v, want running", status)
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorCloseWaitsForEnsureAndCleansProcess(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		close(started)
		<-release
		return inputSession{wait: make(chan error)}, nil
	}
	supervisor.relayFn = blockingRelay
	plan := testPlan("channel-1", 10001)
	ensureResult := make(chan error, 1)
	go func() { ensureResult <- supervisor.Ensure(context.Background(), plan) }()
	waitForSignal(t, started, "startup")
	closeResult := make(chan error, 1)
	go func() { closeResult <- supervisor.Close() }()
	waitForClosed(t, supervisor)
	stopResult := make(chan error, 1)
	go func() { stopResult <- supervisor.Stop(context.Background(), "channel-1") }()
	select {
	case err := <-closeResult:
		t.Fatalf("Close returned while Ensure was starting: %v", err)
	default:
	}
	select {
	case err := <-stopResult:
		t.Fatalf("Stop returned before Close cleaned the listener: %v", err)
	default:
	}
	close(release)
	if err := <-ensureResult; err != nil {
		t.Fatal(err)
	}
	if err := <-closeResult; err != nil {
		t.Fatal(err)
	}
	if err := <-stopResult; err != nil {
		t.Fatal(err)
	}
	if status := supervisor.Snapshot("channel-1"); status.State != StateStopped {
		t.Fatalf("relay status after Close = %#v", status)
	}
	if err := supervisor.Ensure(context.Background(), plan); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("Ensure() after Close error = %v", err)
	}
}

func TestSupervisorEnsureStartupCancellation(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	started := make(chan struct{})
	supervisor.startFn = func(ctx context.Context, _ string) (inputSession, error) {
		wait := make(chan error, 1)
		go func() {
			<-ctx.Done()
			wait <- ctx.Err()
		}()
		close(started)
		return inputSession{wait: wait}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- supervisor.Ensure(ctx, testPlan("channel-1", 10001)) }()
	waitForSignal(t, started, "startup")
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Ensure() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Ensure did not return after startup cancellation")
	}
	if status := supervisor.Snapshot("channel-1"); status.State != StateStopped {
		t.Fatalf("relay status = %#v", status)
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorStartupFailureUnblocksQueuedEnsure(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	firstStarted := make(chan struct{})
	secondStarted := make(chan struct{})
	releaseFailure := make(chan struct{})
	var starts atomic.Int32
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		if starts.Add(1) == 1 {
			close(firstStarted)
			<-releaseFailure
			return inputSession{}, errors.New("startup failed")
		}
		close(secondStarted)
		return inputSession{wait: make(chan error)}, nil
	}
	supervisor.relayFn = blockingRelay
	plan := testPlan("channel-1", 10001)

	firstResult := make(chan error, 1)
	go func() { firstResult <- supervisor.Ensure(context.Background(), plan) }()
	waitForSignal(t, firstStarted, "failed startup")
	secondResult := make(chan error, 1)
	go func() { secondResult <- supervisor.Ensure(context.Background(), plan) }()
	waitForActiveOperations(t, supervisor, 2)
	close(releaseFailure)
	if err := <-firstResult; err == nil || err.Error() != "startup failed" {
		t.Fatalf("first Ensure() error = %v", err)
	}
	waitForSignal(t, secondStarted, "queued startup")
	if err := <-secondResult; err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorReportsRestartFailures(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	var starts atomic.Int32
	wait := make(chan error)
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		if starts.Add(1) == 1 {
			return inputSession{wait: wait}, nil
		}
		return inputSession{}, errors.New("restart failed")
	}
	supervisor.relayFn = func(context.Context, channel.SRTIngestPlan, inputSession) (string, error) {
		return "mpegts", errors.New("connection ended")
	}
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		Port: 10000, DestinationAddress: ":8890",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Ensure(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close()

	deadline := time.Now().Add(2 * time.Second)
	for {
		status := supervisor.Snapshot("channel-1")
		if status.State == StateRetrying && status.LastError == "restart failed" && status.NextRetryAt != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("relay status = %#v", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSupervisorReportsSafeLocalPushListener(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		return inputSession{wait: make(chan error)}, nil
	}
	supervisor.relayFn = func(ctx context.Context, _ channel.SRTIngestPlan, _ inputSession) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		BindAddress: "192.0.2.20", Port: 10000, DestinationAddress: ":8890", Passphrase: "0123456789",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Ensure(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	status := supervisor.Snapshot("channel-1")
	if status.ListenerAddress != "192.0.2.20:10000" || !status.ListenerActive {
		t.Fatalf("listener status = %#v", status)
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorBacksOffRepeatedPostLaunchExits(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	var starts atomic.Int32
	wait := make(chan error)
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		starts.Add(1)
		return inputSession{wait: wait}, nil
	}
	supervisor.relayFn = func(context.Context, channel.SRTIngestPlan, inputSession) (string, error) {
		return "", errors.New("process exited")
	}
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		Port: 10000, DestinationAddress: ":8890",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Ensure(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close()

	deadline := time.Now().Add(2 * time.Second)
	for {
		status := supervisor.Snapshot("channel-1")
		if starts.Load() >= 2 && status.State == StateRetrying && status.LastError == "process exited" && status.NextRetryAt != nil {
			if remaining := time.Until(*status.NextRetryAt); remaining < 300*time.Millisecond {
				t.Fatalf("second crash retry delay = %s", remaining)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("starts = %d, status = %#v", starts.Load(), status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSnapshotDoesNotBlockWhileListenerIsStopping(t *testing.T) {
	supervisor := newTestSupervisor(t, "unused")
	wait := make(chan error)
	relayStarted := make(chan struct{})
	releaseRelay := make(chan struct{})
	supervisor.startFn = func(context.Context, string) (inputSession, error) {
		return inputSession{wait: wait}, nil
	}
	supervisor.relayFn = func(context.Context, channel.SRTIngestPlan, inputSession) (string, error) {
		close(relayStarted)
		<-releaseRelay
		return "", nil
	}
	plan, err := supervisor.Prepare(context.Background(), channel.SRTListener{
		ChannelID: "channel-1", Path: "studio-camera", Mode: channel.InputSRTPush,
		Port: 10000, DestinationAddress: ":8890",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Ensure(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	<-relayStarted
	stopped := make(chan error, 1)
	go func() { stopped <- supervisor.Stop(context.Background(), "channel-1") }()

	deadline := time.Now().Add(time.Second)
	for supervisor.Snapshot("channel-1").State != StateStopping {
		if time.Now().After(deadline) {
			t.Fatal("listener did not enter stopping state")
		}
		time.Sleep(time.Millisecond)
	}
	close(releaseRelay)
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	if status := supervisor.Snapshot("channel-1"); status.State != StateStopped {
		t.Fatalf("relay status = %#v", status)
	}
}

func TestRestartDelayIsCapped(t *testing.T) {
	if got := restartDelay(0); got != 250*time.Millisecond {
		t.Fatalf("restartDelay(0) = %s", got)
	}
	if got := restartDelay(1); got != 500*time.Millisecond {
		t.Fatalf("restartDelay(1) = %s", got)
	}
	if got := restartDelay(20); got != maximumRestartDelay {
		t.Fatalf("restartDelay(20) = %s", got)
	}
}

func newTestSupervisor(t *testing.T, srtExecutable string) *Supervisor {
	t.Helper()
	return New(slog.New(slog.NewTextHandler(io.Discard, nil)), srtExecutable)
}

type packetRead struct {
	data []byte
	err  error
}

type fakePacketConn struct {
	reads     chan packetRead
	deadlines atomic.Int32
}

func newFakePacketConn() *fakePacketConn {
	return &fakePacketConn{reads: make(chan packetRead, 8)}
}

func (p *fakePacketConn) ReadFromUDP(buffer []byte) (int, *net.UDPAddr, error) {
	result := <-p.reads
	return copy(buffer, result.data), nil, result.err
}

func (p *fakePacketConn) SetReadDeadline(time.Time) error {
	p.deadlines.Add(1)
	p.reads <- packetRead{err: timeoutError{}}
	return nil
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func blockingRelay(ctx context.Context, _ channel.SRTIngestPlan, _ inputSession) (string, error) {
	<-ctx.Done()
	return "", ctx.Err()
}

func testPlan(channelID string, port int) channel.SRTIngestPlan {
	return channel.SRTIngestPlan{
		Listener: channel.SRTListener{
			ChannelID: channelID, Path: channelID, Mode: channel.InputSRTPush,
			Port: port, DestinationAddress: ":8890",
		},
		Source: "publisher", OutputAddress: "srt://127.0.0.1:8890",
	}
}

func waitForSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func waitForActiveOperations(t *testing.T, supervisor *Supervisor, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		supervisor.mu.Lock()
		got := supervisor.activeOperations
		supervisor.mu.Unlock()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("active operations = %d, want %d", got, want)
		}
		time.Sleep(time.Millisecond)
	}
}

func waitForClosed(t *testing.T, supervisor *Supervisor) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		supervisor.mu.Lock()
		closed := supervisor.closed
		supervisor.mu.Unlock()
		if closed {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("supervisor did not begin closing")
		}
		time.Sleep(time.Millisecond)
	}
}
