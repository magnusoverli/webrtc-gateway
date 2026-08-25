package srtrelay

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os/exec"
	"slices"
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
	outputValue, err := buildPublishEndpoint(config)
	if err != nil {
		t.Fatal(err)
	}
	output, _ := url.Parse(outputValue)
	if output.Hostname() != "127.0.0.1" || output.Port() != "8890" || output.Query().Get("streamid") != "publish:studio-camera" ||
		output.Query().Has("passphrase") || output.Query().Get("latency") != "60000" || output.Query().Get("sndbuf") != "4194304" ||
		output.Query().Get("connect_timeout") != "1000" || output.Query().Get("timeout") != "3000000" || output.Query().Get("pkt_size") != "1316" ||
		output.Query().Has("conntimeo") || output.Query().Has("peeridletimeo") {
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
	output, parseErr := url.Parse(plan.OutputAddress)
	if plan.Source != "publisher" || plan.RTPSDP != "" || plan.PublishPassphrase != "0123456789" || parseErr != nil || output.Query().Get("streamid") != "publish:studio-camera" {
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
	if output, parseErr := url.Parse(plan.OutputAddress); parseErr != nil || output.Query().Has("passphrase") {
		t.Fatalf("output endpoint exposes internal passphrase: %q", plan.OutputAddress)
	}
}

func TestBuildPublishEndpointKeepsPassphraseOutOfURL(t *testing.T) {
	value, err := buildPublishEndpoint(channel.SRTListener{
		Path: "studio-camera", DestinationAddress: "127.0.0.1:8890",
	})
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := url.Parse(value)
	if err != nil || endpoint.Query().Has("passphrase") {
		t.Fatalf("publish endpoint = %q, %v", value, err)
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

func TestClassifyPayloadFindsRawTSSyncAcrossMessages(t *testing.T) {
	stream := append([]byte{1, 2, 3}, make([]byte, 188*3)...)
	stream[3], stream[3+188], stream[3+2*188] = 0x47, 0x47, 0x47
	reader := packetReaderForMessages(stream[:100], stream[100:300], stream[300:])
	defer reader.close()

	mode, initial, err := classifyPayload(reader)
	if err != nil {
		t.Fatalf("classifyPayload() error = %v", err)
	}
	if mode != payloadMPEGTS || !slices.Equal(initial, stream[3:]) {
		t.Fatalf("classifyPayload() = %v, %d initial bytes", mode, len(initial))
	}
}

func TestClassifyPayloadRequiresTwoRTPMP2TMessages(t *testing.T) {
	payload := make([]byte, 188)
	payload[0] = 0x47
	packet := testRTPPacket(rtpMP2TPayloadType, payload)

	t.Run("one message", func(t *testing.T) {
		wantErr := errors.New("input stopped")
		packets := &fakePacketConn{reads: make(chan packetRead, 2)}
		packets.reads <- packetRead{data: packet}
		packets.reads <- packetRead{err: wantErr}
		reader := newPacketReader(context.Background(), packets)
		defer reader.close()
		if _, _, err := classifyPayload(reader); !errors.Is(err, wantErr) {
			t.Fatalf("classifyPayload() error = %v, want %v", err, wantErr)
		}
	})

	t.Run("two messages", func(t *testing.T) {
		reader := packetReaderForMessages(packet, packet)
		defer reader.close()
		mode, initial, err := classifyPayload(reader)
		if err != nil {
			t.Fatalf("classifyPayload() error = %v", err)
		}
		if mode != payloadRTPMP2T || !slices.Equal(initial, append(append([]byte(nil), payload...), payload...)) {
			t.Fatalf("classifyPayload() = %v, %d initial bytes", mode, len(initial))
		}
	})
}

func TestClassifyPayloadDetectsElementaryRTPAfterThreeMessages(t *testing.T) {
	packet := testRTPPacket(96, []byte{1})
	reader := packetReaderForMessages(packet, packet, packet)
	defer reader.close()
	_, _, err := classifyPayload(reader)
	if err == nil || err.Error() != "elementary RTP payload type 96 requires an SDP in the channel SRT settings" {
		t.Fatalf("classifyPayload() error = %v", err)
	}
}

func TestClassifyPayloadBoundsTinyMalformedMessages(t *testing.T) {
	for name, packet := range map[string][]byte{
		"one byte": {0},
		"empty":    {},
	} {
		t.Run(name, func(t *testing.T) {
			packets := &repeatingPacketConn{packet: packet}
			reader := newPacketReader(context.Background(), packets)
			defer reader.close()
			_, _, err := classifyPayload(reader)
			want := "SRT payload is neither MPEG-TS nor RTP/MP2T payload type 33 after 65536 bytes"
			if err == nil || err.Error() != want {
				t.Fatalf("classifyPayload() error = %v", err)
			}
			if packets.reads != classificationMessageLimit {
				t.Fatalf("packet reads = %d, want %d", packets.reads, classificationMessageLimit)
			}
		})
	}
}

func TestRemuxArgsCopyMPEGTSAndRepeatHeaders(t *testing.T) {
	const passphrase = "plus+percent%secret"
	args := remuxArgs("srt://127.0.0.1:8890?streamid=publish:test", passphrase)
	for _, pair := range [][2]string{
		{"-f", "mpegts"}, {"-i", "pipe:0"}, {"-map", "0:v?"}, {"-map", "0:a?"},
		{"-c", "copy"}, {"-mpegts_flags", "+resend_headers"}, {"-pes_payload_size", "0"}, {"-muxdelay", "0"},
		{"-mpegts_copyts", "1"},
	} {
		if !containsArgumentPair(args, pair[0], pair[1]) {
			t.Fatalf("remux args missing %q %q: %#v", pair[0], pair[1], args)
		}
	}
	if got := args[len(args)-1]; got != "srt://127.0.0.1:8890?streamid=publish:test" {
		t.Fatalf("remux output = %q", got)
	}
	if !slices.Contains(args, "-copyts") {
		t.Fatalf("remux args do not preserve timestamps: %#v", args)
	}
	if !containsArgumentPair(args, "-passphrase", passphrase) || strings.Contains(args[len(args)-1], passphrase) {
		t.Fatalf("remux passphrase is not a separate output option: %#v", args)
	}
}

func TestWriteFullHandlesShortWrites(t *testing.T) {
	output := &shortWriter{limit: 3}
	if err := writeFull(output, []byte("complete payload")); err != nil {
		t.Fatal(err)
	}
	if got := output.value.String(); got != "complete payload" {
		t.Fatalf("written payload = %q", got)
	}
}

func TestBoundedWriterPreservesTrimmedTailAcrossWraps(t *testing.T) {
	writer := newBoundedWriter(8)
	var all []byte
	for _, chunk := range [][]byte{[]byte("ab"), []byte("cdefgh"), []byte("ijk"), []byte("  oversized tail \n")} {
		written, err := writer.Write(chunk)
		if err != nil || written != len(chunk) {
			t.Fatalf("Write() = %d, %v", written, err)
		}
		all = append(all, chunk...)
		tail := all[max(0, len(all)-8):]
		if got, want := writer.String(), strings.TrimSpace(string(tail)); got != want {
			t.Fatalf("String() = %q, want %q", got, want)
		}
	}

	empty := newBoundedWriter(0)
	if written, err := empty.Write([]byte("discarded")); written != 9 || err != nil || empty.String() != "" {
		t.Fatalf("zero-limit writer = %d, %v, %q", written, err, empty.String())
	}
}

func TestRemuxErrorRedactsPassphrase(t *testing.T) {
	err := remuxError(errors.New("exit status 1"), "failed srt://host?passphrase=supersecret", "supersecret")
	if strings.Contains(err.Error(), "supersecret") || !strings.Contains(err.Error(), "withheld") {
		t.Fatalf("remux error = %q", err)
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

func TestElementaryRelayTerminatesInputAfterSocketError(t *testing.T) {
	packets, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	if err := packets.Close(); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	input := inputSession{cmd: cmd, packets: packets, wait: wait}
	plan := channel.SRTIngestPlan{
		OutputAddress: "127.0.0.1:9",
		RTPSDP:        "v=0\nm=video 0 RTP/AVP 96\na=rtpmap:96 H264/90000\n",
	}
	supervisor := newTestSupervisor(t, "unused")
	result := make(chan error, 1)
	go func() {
		_, relayErr := supervisor.relayConnection(context.Background(), plan, input)
		result <- relayErr
	}()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("relayConnection() error = nil")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relayConnection waited indefinitely for the running input process")
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
	return New(slog.New(slog.NewTextHandler(io.Discard, nil)), srtExecutable, "ffmpeg")
}

func containsArgumentPair(arguments []string, name, value string) bool {
	for index := 0; index+1 < len(arguments); index++ {
		if arguments[index] == name && arguments[index+1] == value {
			return true
		}
	}
	return false
}

type shortWriter struct {
	limit int
	value strings.Builder
}

func (w *shortWriter) Write(value []byte) (int, error) {
	written := min(w.limit, len(value))
	_, _ = w.value.Write(value[:written])
	return written, nil
}

type packetRead struct {
	data []byte
	err  error
}

type fakePacketConn struct {
	reads     chan packetRead
	deadlines atomic.Int32
}

type repeatingPacketConn struct {
	packet []byte
	reads  int
}

func (p *repeatingPacketConn) ReadFromUDP(buffer []byte) (int, *net.UDPAddr, error) {
	p.reads++
	return copy(buffer, p.packet), nil, nil
}

func (p *repeatingPacketConn) SetReadDeadline(time.Time) error {
	return nil
}

func newFakePacketConn() *fakePacketConn {
	return &fakePacketConn{reads: make(chan packetRead, 8)}
}

func packetReaderForMessages(messages ...[]byte) *packetReader {
	packets := &fakePacketConn{reads: make(chan packetRead, len(messages))}
	for _, message := range messages {
		packets.reads <- packetRead{data: message}
	}
	return newPacketReader(context.Background(), packets)
}

func testRTPPacket(payloadType uint8, payload []byte) []byte {
	packet := make([]byte, 12+len(payload))
	packet[0] = 0x80
	packet[1] = payloadType
	copy(packet[12:], payload)
	return packet
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
