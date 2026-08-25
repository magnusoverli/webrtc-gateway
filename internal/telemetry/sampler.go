package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Status string

const (
	StatusOK          Status = "ok"
	StatusWarming     Status = "warming"
	StatusStale       Status = "stale"
	StatusUnavailable Status = "unavailable"
)

// cgroupLimitRefreshInterval bounds how long effective cpuset and controller
// limit changes can remain cached while usage counters keep their one-second cadence.
const cgroupLimitRefreshInterval = 30 * time.Second

type Snapshot struct {
	SampledAt time.Time            `json:"sampledAt"`
	Gateway   ResourceScope        `json:"gateway"`
	Host      ResourceScope        `json:"host"`
	Media     ResourceAvailability `json:"media"`
}

type ResourceScope struct {
	Status    Status     `json:"status"`
	Scope     string     `json:"scope"`
	ErrorCode string     `json:"errorCode,omitempty"`
	SampledAt *time.Time `json:"sampledAt,omitempty"`
	WindowMS  int64      `json:"windowMs,omitempty"`
	CPU       CPU        `json:"cpu"`
	Memory    Memory     `json:"memory"`
}

type ResourceAvailability struct {
	Status    Status `json:"status"`
	Scope     string `json:"scope"`
	ErrorCode string `json:"errorCode,omitempty"`
}

type CPU struct {
	Percent       *float64 `json:"percent"`
	UsedCores     *float64 `json:"usedCores"`
	CapacityCores float64  `json:"capacityCores"`
}

type Memory struct {
	UsedBytes    uint64  `json:"usedBytes"`
	CurrentBytes uint64  `json:"currentBytes,omitempty"`
	TotalBytes   *uint64 `json:"totalBytes"`
}

type Sampler struct {
	logger   *slog.Logger
	interval time.Duration
	paths    sourcePaths
	now      func() time.Time

	mu              sync.RWMutex
	snapshot        Snapshot
	previousGateway *gatewaySample
	previousHost    *hostSample
	cgroupLimits    cgroupLimitCache
}

type sourcePaths struct {
	cgroup      string
	cgroupMount string
	cgroupError error
	proc        string
}

type gatewaySample struct {
	at            time.Time
	usageUsec     uint64
	capacityCores float64
	memoryCurrent uint64
	memoryUsed    uint64
	memoryLimit   *uint64
}

type gatewayLimits struct {
	capacityCores float64
	memoryLimit   *uint64
}

type cgroupLimitCache struct {
	mu        sync.Mutex
	value     gatewayLimits
	refreshAt time.Time
	valid     bool
}

type hostSample struct {
	at           time.Time
	totalTicks   uint64
	idleTicks    uint64
	logicalCores int
	memoryUsed   uint64
	memoryTotal  uint64
}

func New(logger *slog.Logger) *Sampler {
	const cgroupMount = "/sys/fs/cgroup"
	cgroup, err := resolveSelfCgroup(cgroupMount, "/proc")
	return newSampler(logger, time.Second, sourcePaths{
		cgroup: cgroup, cgroupMount: cgroupMount, cgroupError: err, proc: "/proc",
	}, time.Now)
}

func newSampler(logger *slog.Logger, interval time.Duration, paths sourcePaths, now func() time.Time) *Sampler {
	s := &Sampler{
		logger: logger, interval: interval, paths: paths, now: now,
		snapshot: Snapshot{
			Gateway: ResourceScope{Status: StatusUnavailable, Scope: "gateway-cgroup", ErrorCode: "sample_failed"},
			Host:    ResourceScope{Status: StatusUnavailable, Scope: "host", ErrorCode: "sample_failed"},
			Media:   ResourceAvailability{Status: StatusUnavailable, Scope: "mediamtx-cgroup", ErrorCode: "isolated_scope"},
		},
	}
	s.sample()
	return s
}

func (s *Sampler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sample()
		}
	}
}

func (s *Sampler) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snapshot
}

func (s *Sampler) sample() {
	now := s.now()
	var gateway gatewaySample
	gatewayErr := s.paths.cgroupError
	if gatewayErr == nil {
		cgroupMount := s.paths.cgroupMount
		if cgroupMount == "" {
			cgroupMount = s.paths.cgroup
		}
		gateway, gatewayErr = s.collectGateway(s.paths.cgroup, cgroupMount, now)
	}
	host, hostErr := collectHost(s.paths.proc, now)

	s.mu.Lock()
	type collectionFailure struct {
		scope             string
		previous, current Status
		err               error
	}
	failures := make([]collectionFailure, 0, 2)
	next := s.snapshot
	next.SampledAt = now.UTC()
	if gatewayErr == nil {
		next.Gateway = gatewayScope(gateway, s.previousGateway)
		s.previousGateway = &gateway
	} else {
		previousStatus := next.Gateway.Status
		next.Gateway = staleScope(next.Gateway, "gateway-cgroup")
		failures = append(failures, collectionFailure{"gateway", previousStatus, next.Gateway.Status, gatewayErr})
	}
	if hostErr == nil {
		next.Host = hostScope(host, s.previousHost)
		s.previousHost = &host
	} else {
		previousStatus := next.Host.Status
		next.Host = staleScope(next.Host, "host")
		failures = append(failures, collectionFailure{"host", previousStatus, next.Host.Status, hostErr})
	}
	next.Media = ResourceAvailability{Status: StatusUnavailable, Scope: "mediamtx-cgroup", ErrorCode: "isolated_scope"}
	s.snapshot = next
	s.mu.Unlock()

	for _, failure := range failures {
		s.logCollectionFailure(failure.scope, failure.previous, failure.current, failure.err)
	}
}

func (s *Sampler) logCollectionFailure(scope string, previous, current Status, err error) {
	if s.logger != nil && current != previous {
		s.logger.Warn("resource telemetry unavailable", "scope", scope, "error", err)
	}
}

func staleScope(previous ResourceScope, scope string) ResourceScope {
	if previous.Status == StatusOK || previous.Status == StatusWarming || previous.Status == StatusStale {
		previous.Status = StatusStale
		previous.ErrorCode = "sample_failed"
		return previous
	}
	return ResourceScope{Status: StatusUnavailable, Scope: scope, ErrorCode: "sample_failed"}
}

func gatewayScope(current gatewaySample, previous *gatewaySample) ResourceScope {
	total := cloneUint64(current.memoryLimit)
	sampledAt := current.at.UTC()
	result := ResourceScope{
		Status: StatusWarming, Scope: "gateway-cgroup",
		SampledAt: &sampledAt,
		CPU:       CPU{CapacityCores: current.capacityCores},
		Memory:    Memory{UsedBytes: current.memoryUsed, CurrentBytes: current.memoryCurrent, TotalBytes: total},
	}
	if previous == nil || current.usageUsec < previous.usageUsec {
		return result
	}
	elapsed := current.at.Sub(previous.at).Seconds()
	if elapsed <= 0 || current.capacityCores <= 0 {
		return result
	}
	usedCores := float64(current.usageUsec-previous.usageUsec) / 1_000_000 / elapsed
	percent := usedCores / current.capacityCores * 100
	result.Status = StatusOK
	result.WindowMS = current.at.Sub(previous.at).Milliseconds()
	result.CPU.UsedCores = floatPointer(usedCores)
	result.CPU.Percent = floatPointer(percent)
	return result
}

func hostScope(current hostSample, previous *hostSample) ResourceScope {
	total := current.memoryTotal
	sampledAt := current.at.UTC()
	result := ResourceScope{
		Status: StatusWarming, Scope: "host",
		SampledAt: &sampledAt,
		CPU:       CPU{CapacityCores: float64(current.logicalCores)},
		Memory:    Memory{UsedBytes: current.memoryUsed, CurrentBytes: current.memoryUsed, TotalBytes: &total},
	}
	if previous == nil || current.totalTicks <= previous.totalTicks || current.idleTicks < previous.idleTicks {
		return result
	}
	totalDelta := current.totalTicks - previous.totalTicks
	idleDelta := current.idleTicks - previous.idleTicks
	if totalDelta == 0 || idleDelta > totalDelta {
		return result
	}
	percent := float64(totalDelta-idleDelta) / float64(totalDelta) * 100
	usedCores := percent / 100 * float64(current.logicalCores)
	result.Status = StatusOK
	result.WindowMS = current.at.Sub(previous.at).Milliseconds()
	result.CPU.Percent = floatPointer(percent)
	result.CPU.UsedCores = floatPointer(usedCores)
	return result
}

func (s *Sampler) collectGateway(root, mount string, at time.Time) (gatewaySample, error) {
	limits, err := s.cgroupLimits.get(root, mount, at)
	if err != nil {
		return gatewaySample{}, err
	}
	return collectGatewayUsage(root, at, limits)
}

func (c *cgroupLimitCache) get(root, mount string, at time.Time) (gatewayLimits, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.valid && at.Before(c.refreshAt) {
		return c.value, nil
	}
	limits, err := readGatewayLimits(root, mount)
	if err != nil {
		return gatewayLimits{}, err
	}
	c.value = limits
	c.refreshAt = at.Add(cgroupLimitRefreshInterval)
	c.valid = true
	return limits, nil
}

func collectGateway(root, mount string, at time.Time) (gatewaySample, error) {
	limits, err := readGatewayLimits(root, mount)
	if err != nil {
		return gatewaySample{}, err
	}
	return collectGatewayUsage(root, at, limits)
}

func collectGatewayUsage(root string, at time.Time, limits gatewayLimits) (gatewaySample, error) {
	usage, err := readUintField(filepath.Join(root, "cpu.stat"), "usage_usec")
	if err != nil {
		return gatewaySample{}, fmt.Errorf("read cpu usage: %w", err)
	}
	current, err := readUintFile(filepath.Join(root, "memory.current"))
	if err != nil {
		return gatewaySample{}, fmt.Errorf("read memory usage: %w", err)
	}
	inactive, err := readUintField(filepath.Join(root, "memory.stat"), "inactive_file")
	if err != nil {
		return gatewaySample{}, fmt.Errorf("read memory working set: %w", err)
	}
	if inactive > current {
		return gatewaySample{}, fmt.Errorf("memory inactive file cache exceeds current usage")
	}
	used := current - inactive
	return gatewaySample{
		at: at, usageUsec: usage, capacityCores: limits.capacityCores,
		memoryCurrent: current, memoryUsed: used, memoryLimit: limits.memoryLimit,
	}, nil
}

func collectHost(procRoot string, at time.Time) (hostSample, error) {
	statData, err := os.ReadFile(filepath.Join(procRoot, "stat"))
	if err != nil {
		return hostSample{}, fmt.Errorf("read cpu totals: %w", err)
	}
	total, idle, cores, err := parseProcStat(statData)
	if err != nil {
		return hostSample{}, err
	}
	memoryData, err := os.ReadFile(filepath.Join(procRoot, "meminfo"))
	if err != nil {
		return hostSample{}, fmt.Errorf("read memory totals: %w", err)
	}
	memoryTotal, memoryAvailable, err := parseMeminfo(memoryData)
	if err != nil {
		return hostSample{}, err
	}
	return hostSample{
		at: at, totalTicks: total, idleTicks: idle, logicalCores: cores,
		memoryUsed: memoryTotal - memoryAvailable, memoryTotal: memoryTotal,
	}, nil
}

func readGatewayLimits(root, mount string) (gatewayLimits, error) {
	hierarchy, err := cgroupHierarchy(root, mount)
	if err != nil {
		return gatewayLimits{}, err
	}
	capacity, err := cpuCapacity(root, hierarchy)
	if err != nil {
		return gatewayLimits{}, fmt.Errorf("read cpu capacity: %w", err)
	}
	limit, err := memoryLimit(hierarchy)
	if err != nil {
		return gatewayLimits{}, fmt.Errorf("read memory limit: %w", err)
	}
	return gatewayLimits{capacityCores: capacity, memoryLimit: limit}, nil
}

func cpuCapacity(root string, hierarchy []string) (float64, error) {
	cpus := runtime.NumCPU()
	if data, err := os.ReadFile(filepath.Join(root, "cpuset.cpus.effective")); err == nil {
		if count, parseErr := parseCPUSet(strings.TrimSpace(string(data))); parseErr == nil && count > 0 {
			cpus = count
		}
	}
	capacity := float64(cpus)
	for _, cgroup := range hierarchy {
		data, readErr := os.ReadFile(filepath.Join(cgroup, "cpu.max"))
		if errors.Is(readErr, os.ErrNotExist) {
			continue
		}
		if readErr != nil {
			return 0, readErr
		}
		fields := bytes.Fields(data)
		if len(fields) != 2 {
			return 0, fmt.Errorf("invalid cpu.max")
		}
		if !bytes.Equal(fields[0], []byte("max")) {
			quota, quotaErr := strconv.ParseFloat(string(fields[0]), 64)
			period, periodErr := strconv.ParseFloat(string(fields[1]), 64)
			if quotaErr != nil || periodErr != nil || quota <= 0 || period <= 0 {
				return 0, fmt.Errorf("invalid cpu.max")
			}
			if limited := quota / period; limited < capacity {
				capacity = limited
			}
		}
	}
	if capacity <= 0 {
		return 0, fmt.Errorf("no effective CPUs")
	}
	return capacity, nil
}

func memoryLimit(hierarchy []string) (*uint64, error) {
	var effective *uint64
	for _, cgroup := range hierarchy {
		limit, readErr := readLimit(filepath.Join(cgroup, "memory.max"))
		if errors.Is(readErr, os.ErrNotExist) {
			continue
		}
		if readErr != nil {
			return nil, readErr
		}
		if limit != nil && (effective == nil || *limit < *effective) {
			effective = limit
		}
	}
	return effective, nil
}

func resolveSelfCgroup(mount, procRoot string) (string, error) {
	data, err := os.ReadFile(filepath.Join(procRoot, "self", "cgroup"))
	if err != nil {
		return "", fmt.Errorf("read process cgroup: %w", err)
	}
	cgroupPath, err := parseSelfCgroup(string(data))
	if err != nil {
		return "", err
	}
	root := filepath.Join(filepath.Clean(mount), strings.TrimPrefix(cgroupPath, "/"))
	if _, err := cgroupHierarchy(root, mount); err != nil {
		return "", err
	}
	return root, nil
}

func parseSelfCgroup(value string) (string, error) {
	for _, line := range strings.Split(value, "\n") {
		fields := strings.SplitN(line, ":", 3)
		if len(fields) != 3 || fields[0] != "0" || fields[1] != "" {
			continue
		}
		path := filepath.Clean(fields[2])
		if !filepath.IsAbs(path) {
			return "", fmt.Errorf("invalid cgroup v2 path")
		}
		return path, nil
	}
	return "", fmt.Errorf("cgroup v2 process path not found")
}

func cgroupHierarchy(root, mount string) ([]string, error) {
	root = filepath.Clean(root)
	mount = filepath.Clean(mount)
	relative, err := filepath.Rel(mount, root)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("cgroup path is outside the cgroup v2 mount")
	}
	paths := []string{root}
	for current := root; current != mount; {
		current = filepath.Dir(current)
		paths = append(paths, current)
	}
	return paths, nil
}

func parseCPUSet(value string) (int, error) {
	if value == "" {
		return 0, fmt.Errorf("empty CPU set")
	}
	count := 0
	for _, part := range strings.Split(value, ",") {
		bounds := strings.Split(part, "-")
		start, err := strconv.Atoi(bounds[0])
		if err != nil || start < 0 || len(bounds) > 2 {
			return 0, fmt.Errorf("invalid CPU set")
		}
		end := start
		if len(bounds) == 2 {
			end, err = strconv.Atoi(bounds[1])
			if err != nil || end < start {
				return 0, fmt.Errorf("invalid CPU set")
			}
		}
		count += end - start + 1
	}
	return count, nil
}

func parseProcStat(value []byte) (uint64, uint64, int, error) {
	scanner := bufio.NewScanner(bytes.NewReader(value))
	var total, idle uint64
	cores := 0
	for scanner.Scan() {
		fields := bytes.Fields(scanner.Bytes())
		if len(fields) == 0 {
			continue
		}
		if bytes.Equal(fields[0], []byte("cpu")) {
			if len(fields) < 6 {
				return 0, 0, 0, fmt.Errorf("invalid /proc/stat CPU line")
			}
			for index := 0; index < min(len(fields)-1, 8); index++ {
				parsed, err := parseUintBytes(fields[index+1])
				if err != nil {
					return 0, 0, 0, fmt.Errorf("invalid /proc/stat CPU value")
				}
				total += parsed
				if index == 3 || index == 4 {
					idle += parsed
				}
			}
		} else if len(fields[0]) > 3 && bytes.Equal(fields[0][:3], []byte("cpu")) {
			if _, err := parseUintBytes(fields[0][3:]); err == nil {
				cores++
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, 0, err
	}
	if total == 0 || cores == 0 {
		return 0, 0, 0, fmt.Errorf("missing /proc/stat CPU data")
	}
	return total, idle, cores, nil
}

func parseMeminfo(value []byte) (uint64, uint64, error) {
	var total, available uint64
	var totalOK, availableOK bool
	scanner := bufio.NewScanner(bytes.NewReader(value))
	for scanner.Scan() {
		parts := bytes.Fields(scanner.Bytes())
		if len(parts) < 2 {
			continue
		}
		isTotal := bytes.Equal(parts[0], []byte("MemTotal:"))
		isAvailable := bytes.Equal(parts[0], []byte("MemAvailable:"))
		if !isTotal && !isAvailable {
			continue
		}
		amount, err := parseUintBytes(parts[1])
		if err != nil {
			return 0, 0, fmt.Errorf("invalid /proc/meminfo value")
		}
		if isTotal {
			total, totalOK = amount*1024, true
		} else {
			available, availableOK = amount*1024, true
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if !totalOK || !availableOK || available > total {
		return 0, 0, fmt.Errorf("missing /proc/meminfo values")
	}
	return total, available, nil
}

func parseUintBytes(value []byte) (uint64, error) {
	if len(value) == 0 {
		return 0, strconv.ErrSyntax
	}
	const maxUint64 = ^uint64(0)
	var parsed uint64
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return 0, strconv.ErrSyntax
		}
		next := uint64(digit - '0')
		if parsed > (maxUint64-next)/10 {
			return 0, strconv.ErrRange
		}
		parsed = parsed*10 + next
	}
	return parsed, nil
}

func readUintField(path, name string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[0] != name {
			continue
		}
		return strconv.ParseUint(fields[1], 10, 64)
	}
	return 0, fmt.Errorf("field %s is missing", name)
}

func readUintFile(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
}

func readLimit(path string) (*uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	value := strings.TrimSpace(string(data))
	if value == "max" {
		return nil, nil
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func floatPointer(value float64) *float64 {
	return &value
}

func cloneUint64(value *uint64) *uint64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
