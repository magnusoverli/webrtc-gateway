package srtrelay

import (
	"context"
	"io"
	"log/slog"
	"net/url"
	"strings"
	"testing"

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

func newTestSupervisor(t *testing.T, srtExecutable string) *Supervisor {
	t.Helper()
	return New(slog.New(slog.NewTextHandler(io.Discard, nil)), srtExecutable)
}
