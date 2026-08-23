package srtrelay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"webrtc-gateway/internal/channel"
)

const (
	startupGrace            = 150 * time.Millisecond
	maximumRestartDelay     = 30 * time.Second
	listenerCapacityWarning = 40
	classificationLimit     = 64 * 1024
	maximumUDPPacketSize    = 64 * 1024
	bridgeReadBufferSize    = 4 * 1024 * 1024
	bridgeWriteBufferSize   = 1 * 1024 * 1024
	rtpMP2TPayloadType      = 33
)

const (
	StateRunning  = "running"
	StateStarting = "starting"
	StateRetrying = "retrying"
	StateStopping = "stopping"
	StateStopped  = "stopped"
)

type Status struct {
	State       string     `json:"state"`
	Restarts    int        `json:"restarts"`
	LastError   string     `json:"lastError,omitempty"`
	NextRetryAt *time.Time `json:"nextRetryAt,omitempty"`
}

type listenerProcess struct {
	plan     channel.SRTIngestPlan
	cancel   context.CancelFunc
	done     chan struct{}
	statusMu sync.RWMutex
	status   Status
}

func (p *listenerProcess) setStatus(state string, restarts int, lastError string, nextRetryAt *time.Time) {
	p.statusMu.Lock()
	defer p.statusMu.Unlock()
	p.status = Status{State: state, Restarts: restarts, LastError: lastError, NextRetryAt: nextRetryAt}
}

func (p *listenerProcess) snapshot() Status {
	p.statusMu.RLock()
	defer p.statusMu.RUnlock()
	result := p.status
	if p.status.NextRetryAt != nil {
		next := *p.status.NextRetryAt
		result.NextRetryAt = &next
	}
	return result
}

type inputSession struct {
	cmd     *exec.Cmd
	packets *net.UDPConn
	wait    <-chan error
}

type payloadMode int

const (
	payloadUnknown payloadMode = iota
	payloadMPEGTS
	payloadRTPMP2T
)

type rtpPacket struct {
	payloadType uint8
	sequence    uint16
	timestamp   uint32
	ssrc        uint32
	payload     []byte
}

type Supervisor struct {
	logger     *slog.Logger
	executable string

	mu        sync.Mutex
	listeners map[string]*listenerProcess
	prepared  map[string]channel.SRTIngestPlan
	snapshots sync.Map
	closed    bool
	startFn   func(context.Context, string) (inputSession, error)
	relayFn   func(context.Context, channel.SRTIngestPlan, inputSession) (string, error)
}

func New(logger *slog.Logger, executable string) *Supervisor {
	supervisor := &Supervisor{
		logger: logger, executable: executable,
		listeners: make(map[string]*listenerProcess),
		prepared:  make(map[string]channel.SRTIngestPlan),
	}
	supervisor.startFn = supervisor.startInput
	supervisor.relayFn = supervisor.relayConnection
	return supervisor
}

func (s *Supervisor) Snapshot(channelID string) Status {
	value, ok := s.snapshots.Load(channelID)
	if !ok {
		return Status{State: StateStopped}
	}
	return value.(*listenerProcess).snapshot()
}

func (s *Supervisor) Prepare(ctx context.Context, config channel.SRTListener) (channel.SRTIngestPlan, error) {
	if err := ctx.Err(); err != nil {
		return channel.SRTIngestPlan{}, err
	}
	if _, err := buildInputEndpoint(config); err != nil {
		return channel.SRTIngestPlan{}, err
	}
	if config.SDP != "" {
		if _, err := elementaryPayloadTypes(config.SDP); err != nil {
			return channel.SRTIngestPlan{}, err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return channel.SRTIngestPlan{}, errors.New("SRT relay supervisor is closed")
	}
	if current := s.listeners[config.ChannelID]; current != nil && current.plan.Listener == config {
		return current.plan, nil
	}
	if prepared, ok := s.prepared[config.ChannelID]; ok && prepared.Listener == config {
		return prepared, nil
	}

	plan := channel.SRTIngestPlan{Listener: config, RTPSDP: config.SDP}
	if config.SDP != "" {
		address, err := availableLoopbackUDPAddress()
		if err != nil {
			return channel.SRTIngestPlan{}, err
		}
		source := &url.URL{Scheme: "udp+rtp", Host: address}
		query := source.Query()
		query.Set("source", "127.0.0.1")
		source.RawQuery = query.Encode()
		plan.Source = source.String()
		plan.OutputAddress = address
	} else {
		publishPassphrase := config.Passphrase
		if config.Mode == channel.InputSRTPull {
			var err error
			publishPassphrase, err = internalPassphrase()
			if err != nil {
				return channel.SRTIngestPlan{}, err
			}
		}
		output, err := buildPublishEndpoint(config, publishPassphrase)
		if err != nil {
			return channel.SRTIngestPlan{}, err
		}
		plan.Source = "publisher"
		plan.PublishPassphrase = publishPassphrase
		plan.OutputAddress = output
	}
	s.prepared[config.ChannelID] = plan
	return plan, nil
}

func (s *Supervisor) Ensure(ctx context.Context, plan channel.SRTIngestPlan) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	inputEndpoint, err := buildInputEndpoint(plan.Listener)
	if err != nil {
		return err
	}
	if plan.RTPSDP != "" {
		if _, err := elementaryPayloadTypes(plan.RTPSDP); err != nil {
			return err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("SRT relay supervisor is closed")
	}
	if current := s.listeners[plan.Listener.ChannelID]; current != nil && current.plan == plan {
		if current.snapshot().State != StateStopping {
			return nil
		}
	}
	if current := s.listeners[plan.Listener.ChannelID]; current != nil {
		if err := s.stopLocked(ctx, plan.Listener.ChannelID, current); err != nil {
			return err
		}
	}

	processCtx, cancel := context.WithCancel(context.Background())
	session, err := s.startFn(processCtx, inputEndpoint)
	if err != nil {
		cancel()
		return err
	}
	timer := time.NewTimer(startupGrace)
	defer timer.Stop()
	select {
	case err := <-session.wait:
		cancel()
		if err == nil {
			err = errors.New("ingest exited during startup")
		}
		return fmt.Errorf("start SRT ingest on UDP port %d: %w", plan.Listener.Port, err)
	case <-ctx.Done():
		cancel()
		<-session.wait
		return ctx.Err()
	case <-timer.C:
	}

	process := &listenerProcess{
		plan: plan, cancel: cancel, done: make(chan struct{}),
		status: Status{State: StateRunning},
	}
	s.listeners[plan.Listener.ChannelID] = process
	s.snapshots.Store(plan.Listener.ChannelID, process)
	delete(s.prepared, plan.Listener.ChannelID)
	go s.monitor(processCtx, process, inputEndpoint, session)
	s.logger.Info("SRT channel ingest started", "channel", plan.Listener.ChannelID, "mode", plan.Listener.Mode, "port", plan.Listener.Port, "elementaryRTP", plan.RTPSDP != "")
	if len(s.listeners) == listenerCapacityWarning {
		s.logger.Warn("SRT channel ingest count has reached the subprocess scaling threshold", "listeners", len(s.listeners), "recommendation", "use direct stream-ID publishing for raw MPEG-TS when supported")
	}
	return nil
}

func (s *Supervisor) Stop(ctx context.Context, channelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.prepared, channelID)
	if process := s.listeners[channelID]; process != nil {
		return s.stopLocked(ctx, channelID, process)
	}
	return nil
}

func (s *Supervisor) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	clear(s.prepared)
	for channelID, process := range s.listeners {
		process.setStatus(StateStopping, process.snapshot().Restarts, "", nil)
		process.cancel()
		<-process.done
		delete(s.listeners, channelID)
		s.snapshots.CompareAndDelete(channelID, process)
	}
	return nil
}

func (s *Supervisor) stopLocked(ctx context.Context, channelID string, process *listenerProcess) error {
	status := process.snapshot()
	process.setStatus(StateStopping, status.Restarts, status.LastError, nil)
	process.cancel()
	select {
	case <-process.done:
		if s.listeners[channelID] == process {
			delete(s.listeners, channelID)
		}
		s.snapshots.CompareAndDelete(channelID, process)
		s.logger.Info("SRT channel ingest stopped", "channel", channelID, "port", process.plan.Listener.Port)
		return nil
	case <-ctx.Done():
		go s.reap(channelID, process)
		return ctx.Err()
	}
}

func (s *Supervisor) reap(channelID string, process *listenerProcess) {
	<-process.done
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listeners[channelID] == process {
		delete(s.listeners, channelID)
	}
	s.snapshots.CompareAndDelete(channelID, process)
}

func (s *Supervisor) monitor(ctx context.Context, process *listenerProcess, inputEndpoint string, session inputSession) {
	defer func() {
		status := process.snapshot()
		process.setStatus(StateStopped, status.Restarts, status.LastError, nil)
		close(process.done)
	}()
	restarts := 0
	failures := 0
	sessionStarted := time.Now()
	for {
		detected, err := s.relayFn(ctx, process.plan, session)
		if ctx.Err() != nil {
			return
		}
		attributes := []any{"channel", process.plan.Listener.ChannelID, "port", process.plan.Listener.Port}
		if detected != "" {
			attributes = append(attributes, "payload", detected)
		}
		if err != nil {
			attributes = append(attributes, "error", err)
			s.logger.Warn("SRT channel connection ended", attributes...)
			if time.Since(sessionStarted) >= 5*time.Second {
				failures = 0
			}
			failures++
		} else {
			s.logger.Info("SRT sender disconnected", attributes...)
			failures = 0
		}

		lastError := ""
		if err != nil {
			lastError = err.Error()
		}
		for {
			delay := restartDelay(max(0, failures-1))
			nextRetry := time.Now().Add(delay)
			state := StateStarting
			if failures > 0 {
				state = StateRetrying
			}
			process.setStatus(state, restarts, lastError, &nextRetry)
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			var startErr error
			session, startErr = s.startFn(ctx, inputEndpoint)
			if startErr == nil {
				restarts++
				sessionStarted = time.Now()
				process.setStatus(StateRunning, restarts, "", nil)
				break
			}
			failures++
			lastError = startErr.Error()
			process.setStatus(StateRetrying, restarts, lastError, nil)
			s.logger.Warn("SRT channel ingest restart failed", "channel", process.plan.Listener.ChannelID, "port", process.plan.Listener.Port, "error", startErr)
		}
	}
}

func restartDelay(failures int) time.Duration {
	delay := 250 * time.Millisecond
	for range min(failures, 7) {
		delay *= 2
	}
	return min(delay, maximumRestartDelay)
}

func (s *Supervisor) startInput(ctx context.Context, inputEndpoint string) (inputSession, error) {
	packets, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return inputSession{}, fmt.Errorf("open SRT packet bridge: %w", err)
	}
	if err := packets.SetReadBuffer(bridgeReadBufferSize); err != nil {
		packets.Close()
		return inputSession{}, fmt.Errorf("configure SRT packet bridge receive buffer: %w", err)
	}
	udpEndpoint := "udp://" + packets.LocalAddr().String()
	cmd := exec.CommandContext(ctx, s.executable, "-q", "-a:no", inputEndpoint, udpEndpoint)
	if err := cmd.Start(); err != nil {
		packets.Close()
		return inputSession{}, fmt.Errorf("start SRT channel ingest: %w", err)
	}
	wait := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		packets.Close()
		wait <- err
	}()
	return inputSession{cmd: cmd, packets: packets, wait: wait}, nil
}

func (s *Supervisor) relayConnection(ctx context.Context, plan channel.SRTIngestPlan, input inputSession) (string, error) {
	if plan.RTPSDP != "" {
		allowed, err := elementaryPayloadTypes(plan.RTPSDP)
		if err != nil {
			terminateInput(input)
			return "elementary-rtp", err
		}
		destination, err := net.ResolveUDPAddr("udp4", plan.OutputAddress)
		if err != nil {
			terminateInput(input)
			return "elementary-rtp", err
		}
		output, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			terminateInput(input)
			return "elementary-rtp", fmt.Errorf("open MediaMTX RTP bridge: %w", err)
		}
		defer output.Close()
		if err := output.SetWriteBuffer(bridgeWriteBufferSize); err != nil {
			terminateInput(input)
			return "elementary-rtp", fmt.Errorf("configure MediaMTX RTP bridge send buffer: %w", err)
		}
		buffer := make([]byte, maximumUDPPacketSize)
		for {
			packet, err := readPacket(ctx, input.packets, buffer)
			if err != nil {
				return "elementary-rtp", errors.Join(err, <-input.wait)
			}
			if isRTCP(packet) {
				continue
			}
			parsed, err := parseRTP(packet)
			if err != nil {
				terminateInput(input)
				return "elementary-rtp", fmt.Errorf("invalid elementary RTP packet: %w", err)
			}
			if !allowed[parsed.payloadType] {
				terminateInput(input)
				return "elementary-rtp", fmt.Errorf("RTP payload type %d is not declared by the channel SDP", parsed.payloadType)
			}
			if _, err := output.WriteToUDP(packet, destination); err != nil {
				terminateInput(input)
				return "elementary-rtp", fmt.Errorf("forward elementary RTP: %w", err)
			}
		}
	}

	mode, initial, err := classifyPayload(ctx, input.packets)
	if err != nil {
		terminateInput(input)
		return "unknown", err
	}
	output := exec.CommandContext(ctx, s.executable, "-q", "-a:no", "file://con", plan.OutputAddress)
	sink, err := output.StdinPipe()
	if err != nil {
		terminateInput(input)
		return mode.String(), fmt.Errorf("open MediaMTX relay input: %w", err)
	}
	if err := output.Start(); err != nil {
		terminateInput(input)
		return mode.String(), fmt.Errorf("start MediaMTX relay connection: %w", err)
	}
	outputWait := make(chan error, 1)
	go func() { outputWait <- output.Wait() }()
	copyDone := make(chan error, 1)
	go func() {
		_, firstErr := sink.Write(initial)
		streamErr := streamNormalized(ctx, input.packets, sink, mode)
		closeErr := sink.Close()
		copyDone <- errors.Join(firstErr, streamErr, closeErr)
	}()

	select {
	case inputErr := <-input.wait:
		copyErr := <-copyDone
		terminate(output, outputWait)
		return mode.String(), errors.Join(inputErr, copyErr)
	case copyErr := <-copyDone:
		_ = input.cmd.Process.Kill()
		inputErr := <-input.wait
		terminate(output, outputWait)
		return mode.String(), errors.Join(copyErr, inputErr)
	case outputErr := <-outputWait:
		_ = input.cmd.Process.Kill()
		inputErr := <-input.wait
		copyErr := <-copyDone
		return mode.String(), errors.Join(outputErr, inputErr, copyErr)
	case <-ctx.Done():
		_ = input.cmd.Process.Kill()
		_ = output.Process.Kill()
		<-input.wait
		<-outputWait
		<-copyDone
		return mode.String(), ctx.Err()
	}
}

func classifyPayload(ctx context.Context, packets *net.UDPConn) (payloadMode, []byte, error) {
	var messages [][]byte
	total := 0
	buffer := make([]byte, maximumUDPPacketSize)
	for total < classificationLimit {
		packet, err := readPacket(ctx, packets, buffer)
		if err != nil {
			return payloadUnknown, nil, err
		}
		message := append([]byte(nil), packet...)
		messages = append(messages, message)
		total += len(message)

		allRTPMP2T := true
		for _, candidate := range messages {
			packet, err := parseRTP(candidate)
			if err != nil || packet.payloadType != rtpMP2TPayloadType || !validTSPayload(packet.payload) {
				allRTPMP2T = false
				break
			}
		}
		if allRTPMP2T && len(messages) >= 2 {
			initial := make([]byte, 0, total)
			for _, candidate := range messages {
				packet, _ := parseRTP(candidate)
				initial = append(initial, packet.payload...)
			}
			return payloadRTPMP2T, initial, nil
		}

		joined := joinPackets(messages)
		if _, err := parseRTP(messages[0]); err != nil {
			if offset := findTSSync(joined); offset >= 0 {
				return payloadMPEGTS, joined[offset:], nil
			}
		}
		if len(messages) >= 3 {
			allRTP := true
			payloadType := uint8(0)
			for index, candidate := range messages {
				packet, err := parseRTP(candidate)
				if err != nil {
					allRTP = false
					break
				}
				if index == 0 {
					payloadType = packet.payloadType
				}
			}
			if allRTP {
				return payloadUnknown, nil, fmt.Errorf("elementary RTP payload type %d requires an SDP in the channel SRT settings", payloadType)
			}
		}
	}
	return payloadUnknown, nil, fmt.Errorf("SRT payload is neither MPEG-TS nor RTP/MP2T payload type 33 after %d bytes", classificationLimit)
}

func streamNormalized(ctx context.Context, packets *net.UDPConn, sink io.Writer, mode payloadMode) error {
	buffer := make([]byte, maximumUDPPacketSize)
	for {
		message, err := readPacket(ctx, packets, buffer)
		if err != nil {
			return err
		}
		payload := message
		if mode == payloadRTPMP2T {
			packet, err := parseRTP(message)
			if err != nil {
				return fmt.Errorf("invalid RTP/MP2T packet: %w", err)
			}
			if packet.payloadType != rtpMP2TPayloadType || !validTSPayload(packet.payload) {
				return fmt.Errorf("RTP/MP2T stream changed to unsupported payload type %d", packet.payloadType)
			}
			payload = packet.payload
		}
		if _, err := sink.Write(payload); err != nil {
			return err
		}
	}
}

func readPacket(ctx context.Context, packets *net.UDPConn, buffer []byte) ([]byte, error) {
	for {
		if err := packets.SetReadDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
			return nil, err
		}
		n, _, err := packets.ReadFromUDP(buffer)
		if err == nil {
			return buffer[:n], nil
		}
		if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			continue
		}
		return nil, err
	}
}

func parseRTP(value []byte) (rtpPacket, error) {
	if len(value) < 12 || value[0]>>6 != 2 {
		return rtpPacket{}, errors.New("RTP version 2 header is required")
	}
	padding := value[0]&0x20 != 0
	extension := value[0]&0x10 != 0
	headerLength := 12 + int(value[0]&0x0f)*4
	if headerLength > len(value) {
		return rtpPacket{}, errors.New("RTP CSRC list exceeds packet length")
	}
	if extension {
		if headerLength+4 > len(value) {
			return rtpPacket{}, errors.New("RTP extension header is truncated")
		}
		extensionWords := int(value[headerLength+2])<<8 | int(value[headerLength+3])
		headerLength += 4 + extensionWords*4
		if headerLength > len(value) {
			return rtpPacket{}, errors.New("RTP extension data exceeds packet length")
		}
	}
	payloadEnd := len(value)
	if padding {
		paddingLength := int(value[len(value)-1])
		if paddingLength == 0 || paddingLength > payloadEnd-headerLength {
			return rtpPacket{}, errors.New("RTP padding is invalid")
		}
		payloadEnd -= paddingLength
	}
	if payloadEnd <= headerLength {
		return rtpPacket{}, errors.New("RTP packet has no payload")
	}
	return rtpPacket{
		payloadType: value[1] & 0x7f,
		sequence:    uint16(value[2])<<8 | uint16(value[3]),
		timestamp:   uint32(value[4])<<24 | uint32(value[5])<<16 | uint32(value[6])<<8 | uint32(value[7]),
		ssrc:        uint32(value[8])<<24 | uint32(value[9])<<16 | uint32(value[10])<<8 | uint32(value[11]),
		payload:     value[headerLength:payloadEnd],
	}, nil
}

func isRTCP(value []byte) bool {
	if len(value) < 4 || value[0]>>6 != 2 || value[1] < 192 || value[1] > 223 {
		return false
	}
	length := ((int(value[2])<<8 | int(value[3])) + 1) * 4
	return length <= len(value)
}

func validTSPayload(value []byte) bool {
	if len(value) == 0 || len(value)%188 != 0 {
		return false
	}
	for offset := 0; offset < len(value); offset += 188 {
		if value[offset] != 0x47 {
			return false
		}
	}
	return true
}

func findTSSync(value []byte) int {
	for offset := 0; offset < min(188, len(value)); offset++ {
		if offset+2*188 < len(value) && value[offset] == 0x47 && value[offset+188] == 0x47 && value[offset+2*188] == 0x47 {
			return offset
		}
	}
	return -1
}

func joinPackets(messages [][]byte) []byte {
	total := 0
	for _, message := range messages {
		total += len(message)
	}
	result := make([]byte, 0, total)
	for _, message := range messages {
		result = append(result, message...)
	}
	return result
}

func elementaryPayloadTypes(sdp string) (map[uint8]bool, error) {
	allowed := make(map[uint8]bool)
	dynamicMappings := make(map[uint8]string)
	videoSections := 0
	audioSections := 0
	for _, rawLine := range strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if strings.HasPrefix(line, "a=rtpmap:") {
			fields := strings.Fields(strings.TrimPrefix(line, "a=rtpmap:"))
			if len(fields) != 2 {
				return nil, fmt.Errorf("invalid SRT elementary RTP SDP rtpmap line %q", line)
			}
			value, err := strconv.Atoi(fields[0])
			if err != nil || value < 0 || value > 127 {
				return nil, fmt.Errorf("invalid RTP payload type in SDP line %q", line)
			}
			dynamicMappings[uint8(value)] = strings.ToLower(strings.Split(fields[1], "/")[0])
		}
	}
	for _, rawLine := range strings.Split(strings.ReplaceAll(sdp, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if !strings.HasPrefix(line, "m=") {
			continue
		}
		fields := strings.Fields(strings.TrimPrefix(line, "m="))
		if len(fields) != 4 {
			return nil, fmt.Errorf("each SRT elementary RTP SDP media section must declare exactly one payload type: %q", line)
		}
		switch fields[0] {
		case "video":
			videoSections++
		case "audio":
			audioSections++
		default:
			return nil, fmt.Errorf("unsupported SRT elementary RTP SDP media type %q", fields[0])
		}
		if fields[2] != "RTP/AVP" {
			return nil, fmt.Errorf("SRT elementary RTP SDP protocol must be RTP/AVP, got %q", fields[2])
		}
		value, err := strconv.Atoi(fields[3])
		if err != nil || value < 0 || value > 127 {
			return nil, fmt.Errorf("invalid RTP payload type %q", fields[3])
		}
		payloadType := uint8(value)
		if allowed[payloadType] {
			return nil, fmt.Errorf("RTP payload type %d is used by multiple SDP media sections", payloadType)
		}
		if payloadType >= 64 && payloadType <= 95 {
			return nil, fmt.Errorf("RTP payload type %d is ambiguous with RTCP when tunneled over one SRT connection", payloadType)
		}
		encoding := dynamicMappings[payloadType]
		if payloadType >= 96 && encoding == "" {
			return nil, fmt.Errorf("dynamic RTP payload type %d requires an rtpmap in the channel SDP", payloadType)
		}
		if payloadType == rtpMP2TPayloadType || encoding == "mp2t" {
			return nil, errors.New("RTP/MP2T must use automatic payload detection; remove the elementary RTP SDP")
		}
		allowed[payloadType] = true
	}
	if len(allowed) == 0 {
		return nil, errors.New("SRT elementary RTP SDP has no audio or video payload")
	}
	if videoSections > 1 || audioSections > 1 {
		return nil, errors.New("SRT elementary RTP supports at most one video and one audio media section")
	}
	return allowed, nil
}

func buildInputEndpoint(config channel.SRTListener) (string, error) {
	if config.ChannelID == "" || config.Path == "" {
		return "", errors.New("SRT ingest channel and path are required")
	}
	var host string
	switch config.Mode {
	case channel.InputSRTPush:
		if config.Port < 1024 || config.Port > 65535 {
			return "", fmt.Errorf("invalid SRT listener port %d", config.Port)
		}
		if config.BindAddress != "" && net.ParseIP(config.BindAddress) == nil {
			return "", fmt.Errorf("invalid SRT bind address %q", config.BindAddress)
		}
		host = net.JoinHostPort(config.BindAddress, strconv.Itoa(config.Port))
	case channel.InputSRTPull:
		if config.Host == "" || config.Port < 1 || config.Port > 65535 {
			return "", errors.New("valid SRT pull host and port are required")
		}
		host = net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	default:
		return "", fmt.Errorf("unsupported SRT ingest mode %q", config.Mode)
	}
	endpoint := &url.URL{Scheme: "srt", Host: host}
	query := endpoint.Query()
	if config.Mode == channel.InputSRTPush {
		query.Set("mode", "listener")
	} else {
		query.Set("mode", "caller")
		if config.StreamID != "" {
			query.Set("streamid", config.StreamID)
		}
	}
	query.Set("transtype", "live")
	query.Set("messageapi", "1")
	query.Set("conntimeo", "1000")
	query.Set("peeridletimeo", "3000")
	query.Set("rcvbuf", strconv.Itoa(bridgeReadBufferSize))
	if config.Passphrase != "" {
		query.Set("passphrase", config.Passphrase)
	}
	latencyMS := config.LatencyMS
	if latencyMS == 0 {
		latencyMS = channel.DefaultSRTLatencyMS
	}
	query.Set("latency", strconv.Itoa(latencyMS))
	endpoint.RawQuery = query.Encode()
	return endpoint.String(), nil
}

func buildPublishEndpoint(config channel.SRTListener, passphrase string) (string, error) {
	host, port, err := net.SplitHostPort(config.DestinationAddress)
	if err != nil {
		return "", fmt.Errorf("parse MediaMTX SRT listener address: %w", err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	endpoint := "srt://" + net.JoinHostPort(host, port) +
		"?mode=caller&transtype=live&streamid=publish:" + config.Path +
		"&conntimeo=1000&peeridletimeo=3000&sndbuf=" + strconv.Itoa(bridgeReadBufferSize) +
		"&latency=" + strconv.Itoa(channel.DefaultSRTLatencyMS)
	if passphrase != "" {
		if strings.ContainsAny(passphrase, "&?#") {
			return "", errors.New("SRT relay passphrase cannot contain &, ?, or #")
		}
		endpoint += "&passphrase=" + passphrase
	}
	return endpoint, nil
}

func availableLoopbackUDPAddress() (string, error) {
	listener, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return "", fmt.Errorf("allocate MediaMTX RTP bridge port: %w", err)
	}
	address := listener.LocalAddr().String()
	if err := listener.Close(); err != nil {
		return "", err
	}
	return address, nil
}

func internalPassphrase() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate internal SRT passphrase: %w", err)
	}
	return hex.EncodeToString(value), nil
}

func terminateInput(input inputSession) {
	if input.cmd.Process != nil {
		_ = input.cmd.Process.Kill()
	}
	<-input.wait
}

func terminate(cmd *exec.Cmd, wait <-chan error) {
	_ = cmd.Process.Signal(syscall.SIGTERM)
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-wait:
		return
	case <-timer.C:
		_ = cmd.Process.Kill()
		<-wait
	}
}

func (mode payloadMode) String() string {
	switch mode {
	case payloadMPEGTS:
		return "mpegts"
	case payloadRTPMP2T:
		return "rtp-mp2t"
	default:
		return "unknown"
	}
}
