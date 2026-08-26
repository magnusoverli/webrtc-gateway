package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"runtime"
	"strconv"
)

type Config struct {
	ListenAddr      string
	HealthAddr      string
	MediaMTXAPIURL  string
	MediaMTXWHEPURL string
	MediaMTXRTSPURL string
	MediaMTXRTMPURL string
	StatePath       string
	EncoderThreads  int
	WorkerCapacity  int
}

func Load() (Config, error) {
	encoderThreads := min(6, runtime.NumCPU())
	workerCapacity := max(1, runtime.NumCPU()*3/4)
	var err error
	if encoderThreads, err = positiveEnvInt("GATEWAY_COMPATIBILITY_ENCODER_THREADS", encoderThreads, 64); err != nil {
		return Config{}, err
	}
	if workerCapacity, err = positiveEnvInt("GATEWAY_COMPATIBILITY_CAPACITY", workerCapacity, 10000); err != nil {
		return Config{}, err
	}
	cfg := Config{
		ListenAddr:      envOrDefault("GATEWAY_LISTEN_ADDR", ":8080"),
		HealthAddr:      envOrDefault("GATEWAY_HEALTH_LISTEN_ADDR", "127.0.0.1:18080"),
		MediaMTXAPIURL:  envOrDefault("GATEWAY_MEDIAMTX_API_URL", "http://127.0.0.1:9997"),
		MediaMTXWHEPURL: envOrDefault("GATEWAY_MEDIAMTX_WHEP_URL", "http://127.0.0.1:8889"),
		MediaMTXRTSPURL: envOrDefault("GATEWAY_MEDIAMTX_RTSP_URL", "rtsp://127.0.0.1:8554"),
		MediaMTXRTMPURL: envOrDefault("GATEWAY_MEDIAMTX_RTMP_URL", "rtmp://127.0.0.1:1935"),
		StatePath:       envOrDefault("GATEWAY_STATE_PATH", "gateway.db"),
		EncoderThreads:  encoderThreads,
		WorkerCapacity:  workerCapacity,
	}
	for name, value := range map[string]string{
		"GATEWAY_LISTEN_ADDR":        cfg.ListenAddr,
		"GATEWAY_HEALTH_LISTEN_ADDR": cfg.HealthAddr,
	} {
		_, portText, splitErr := net.SplitHostPort(value)
		port, portErr := strconv.Atoi(portText)
		if splitErr != nil || portErr != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("%s must be a listener address such as :8080 or 127.0.0.1:8080", name)
		}
	}

	for name, value := range map[string]string{
		"GATEWAY_MEDIAMTX_API_URL":  cfg.MediaMTXAPIURL,
		"GATEWAY_MEDIAMTX_WHEP_URL": cfg.MediaMTXWHEPURL,
		"GATEWAY_MEDIAMTX_RTSP_URL": cfg.MediaMTXRTSPURL,
		"GATEWAY_MEDIAMTX_RTMP_URL": cfg.MediaMTXRTMPURL,
	} {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return Config{}, fmt.Errorf("%s must be an absolute URL", name)
		}
	}

	return cfg, nil
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func positiveEnvInt(name string, fallback, maximum int) (int, error) {
	text := os.Getenv(name)
	if text == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(text)
	if err != nil || value < 1 || value > maximum {
		return 0, fmt.Errorf("%s must be between 1 and %d", name, maximum)
	}
	return value, nil
}
