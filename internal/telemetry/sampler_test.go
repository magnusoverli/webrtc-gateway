package telemetry

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestParseCPUSet(t *testing.T) {
	count, err := parseCPUSet("0-3,8,10-11")
	if err != nil || count != 7 {
		t.Fatalf("parseCPUSet() = %d, %v; want 7", count, err)
	}
	for _, value := range []string{"", "3-1", "one", "1-2-3"} {
		if _, err := parseCPUSet(value); err == nil {
			t.Fatalf("parseCPUSet(%q) succeeded", value)
		}
	}
}

func TestParsesHostSources(t *testing.T) {
	stat := "cpu  100 10 40 800 20 5 15 10 0 0\ncpu0 1 0 0 1\ncpu1 1 0 0 1\n"
	total, idle, cores, err := parseProcStat(stat)
	if err != nil || total != 1000 || idle != 820 || cores != 2 {
		t.Fatalf("parseProcStat() = %d, %d, %d, %v", total, idle, cores, err)
	}
	memoryTotal, memoryAvailable, err := parseMeminfo("MemTotal: 16384 kB\nMemAvailable: 12288 kB\n")
	if err != nil || memoryTotal != 16*1024*1024 || memoryAvailable != 12*1024*1024 {
		t.Fatalf("parseMeminfo() = %d, %d, %v", memoryTotal, memoryAvailable, err)
	}
}

func TestSamplerCalculatesGatewayAndHostUsage(t *testing.T) {
	cgroup := t.TempDir()
	proc := t.TempDir()
	writeTelemetryFixtures(t, cgroup, proc, 1_000_000, "cpu 100 0 100 800 0 0 0 0", 1_000, 100)
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	sampler := newSampler(nil, time.Hour, sourcePaths{cgroup: cgroup, proc: proc}, func() time.Time { return now })

	first := sampler.Snapshot()
	if first.Gateway.Status != StatusWarming || first.Host.Status != StatusWarming {
		t.Fatalf("first statuses = %q, %q", first.Gateway.Status, first.Host.Status)
	}
	if first.Gateway.Memory.UsedBytes != 900 || first.Gateway.Memory.CurrentBytes != 1_000 || first.Gateway.Memory.TotalBytes == nil || *first.Gateway.Memory.TotalBytes != 2_000 {
		t.Fatalf("gateway memory = %+v", first.Gateway.Memory)
	}

	now = now.Add(time.Second)
	writeTelemetryFixtures(t, cgroup, proc, 2_000_000, "cpu 200 0 200 900 0 0 0 0", 1_200, 100)
	sampler.sample()
	second := sampler.Snapshot()
	if second.Gateway.Status != StatusOK || second.Gateway.CPU.UsedCores == nil || *second.Gateway.CPU.UsedCores != 1 || second.Gateway.CPU.Percent == nil || *second.Gateway.CPU.Percent != 50 {
		t.Fatalf("gateway CPU = %+v (%s)", second.Gateway.CPU, second.Gateway.Status)
	}
	if second.Host.Status != StatusOK || second.Host.CPU.Percent == nil || !closeFloat(*second.Host.CPU.Percent, 66.6666667) || second.Host.CPU.UsedCores == nil || !closeFloat(*second.Host.CPU.UsedCores, 1.3333333) {
		t.Fatalf("host CPU = %+v (%s)", second.Host.CPU, second.Host.Status)
	}
	if second.Gateway.WindowMS != 1_000 || second.Host.WindowMS != 1_000 || second.Media.ErrorCode != "isolated_scope" {
		t.Fatalf("snapshot metadata = %+v", second)
	}
}

func TestSamplerRetainsLastGoodValuesAsStale(t *testing.T) {
	cgroup := t.TempDir()
	proc := t.TempDir()
	writeTelemetryFixtures(t, cgroup, proc, 1_000_000, "cpu 100 0 100 800 0 0 0 0", 1_000, 100)
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	sampler := newSampler(nil, time.Hour, sourcePaths{cgroup: cgroup, proc: proc}, func() time.Time { return now })
	now = now.Add(time.Second)
	writeTelemetryFixtures(t, cgroup, proc, 2_000_000, "cpu 200 0 200 900 0 0 0 0", 1_200, 100)
	sampler.sample()
	lastGood := sampler.Snapshot()

	if err := os.Remove(filepath.Join(cgroup, "cpu.stat")); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	sampler.sample()
	stale := sampler.Snapshot()
	if stale.Gateway.Status != StatusStale || stale.Gateway.ErrorCode != "sample_failed" {
		t.Fatalf("stale gateway = %+v", stale.Gateway)
	}
	if stale.Gateway.CPU.Percent == nil || lastGood.Gateway.CPU.Percent == nil || *stale.Gateway.CPU.Percent != *lastGood.Gateway.CPU.Percent {
		t.Fatalf("stale CPU was not retained: before=%+v after=%+v", lastGood.Gateway.CPU, stale.Gateway.CPU)
	}
	if stale.Gateway.SampledAt == nil || lastGood.Gateway.SampledAt == nil || !stale.Gateway.SampledAt.Equal(*lastGood.Gateway.SampledAt) {
		t.Fatalf("stale sample time changed: before=%v after=%v", lastGood.Gateway.SampledAt, stale.Gateway.SampledAt)
	}
}

func TestResolveSelfCgroup(t *testing.T) {
	mount := t.TempDir()
	proc := t.TempDir()
	if err := os.MkdirAll(filepath.Join(proc, "self"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTelemetryFile(t, filepath.Join(proc, "self", "cgroup"), "0::/system.slice/gateway.scope\n")

	got, err := resolveSelfCgroup(mount, proc)
	want := filepath.Join(mount, "system.slice", "gateway.scope")
	if err != nil || got != want {
		t.Fatalf("resolveSelfCgroup() = %q, %v; want %q", got, err, want)
	}
}

func TestGatewayUsesTightestAncestorLimits(t *testing.T) {
	mount := t.TempDir()
	parent := filepath.Join(mount, "workload.slice")
	cgroup := filepath.Join(parent, "gateway.scope")
	if err := os.MkdirAll(cgroup, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct{ path, value string }{
		{filepath.Join(parent, "cpu.max"), "100000 100000\n"},
		{filepath.Join(parent, "memory.max"), "1500\n"},
		{filepath.Join(cgroup, "cpu.max"), "max 100000\n"},
		{filepath.Join(cgroup, "memory.max"), "2000\n"},
		{filepath.Join(cgroup, "cpuset.cpus.effective"), "0-3\n"},
		{filepath.Join(cgroup, "cpu.stat"), "usage_usec 1000000\n"},
		{filepath.Join(cgroup, "memory.current"), "1000\n"},
		{filepath.Join(cgroup, "memory.stat"), "inactive_file 100\n"},
	} {
		writeTelemetryFile(t, fixture.path, fixture.value)
	}

	sample, err := collectGateway(cgroup, mount, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if sample.capacityCores != 1 || sample.memoryLimit == nil || *sample.memoryLimit != 1500 {
		t.Fatalf("effective limits = CPU %v, memory %v", sample.capacityCores, sample.memoryLimit)
	}
}

func TestGatewayRejectsMissingWorkingSetData(t *testing.T) {
	cgroup := t.TempDir()
	proc := t.TempDir()
	writeTelemetryFixtures(t, cgroup, proc, 1_000_000, "cpu 100 0 100 800 0 0 0 0", 1_000, 100)
	if err := os.Remove(filepath.Join(cgroup, "memory.stat")); err != nil {
		t.Fatal(err)
	}
	if _, err := collectGateway(cgroup, cgroup, time.Now()); err == nil {
		t.Fatal("collectGateway() succeeded without memory.stat")
	}
}

func writeTelemetryFixtures(t *testing.T, cgroup, proc string, usage uint64, cpuLine string, current, inactive uint64) {
	t.Helper()
	writeTelemetryFile(t, filepath.Join(cgroup, "cpu.stat"), "usage_usec "+uintText(usage)+"\n")
	writeTelemetryFile(t, filepath.Join(cgroup, "cpu.max"), "200000 100000\n")
	writeTelemetryFile(t, filepath.Join(cgroup, "cpuset.cpus.effective"), "0-3\n")
	writeTelemetryFile(t, filepath.Join(cgroup, "memory.current"), uintText(current)+"\n")
	writeTelemetryFile(t, filepath.Join(cgroup, "memory.max"), "2000\n")
	writeTelemetryFile(t, filepath.Join(cgroup, "memory.stat"), "inactive_file "+uintText(inactive)+"\n")
	writeTelemetryFile(t, filepath.Join(proc, "stat"), cpuLine+"\ncpu0 1 0 0 1\ncpu1 1 0 0 1\n")
	writeTelemetryFile(t, filepath.Join(proc, "meminfo"), "MemTotal: 16384 kB\nMemAvailable: 12288 kB\n")
}

func writeTelemetryFile(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}

func uintText(value uint64) string {
	return strconv.FormatUint(value, 10)
}

func closeFloat(got, want float64) bool {
	difference := got - want
	if difference < 0 {
		difference = -difference
	}
	return difference < 0.0001
}
