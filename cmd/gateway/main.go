package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/compatibility"
	"webrtc-gateway/internal/config"
	"webrtc-gateway/internal/controlplane"
	"webrtc-gateway/internal/httpapi"
	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
	"webrtc-gateway/internal/reconcile"
	"webrtc-gateway/internal/settings"
	"webrtc-gateway/internal/srtrelay"
)

var version = "dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	mediaClient, err := mediamtx.NewClient(cfg.MediaMTXAPIURL, 3*time.Second)
	if err != nil {
		logger.Error("invalid MediaMTX API URL", "error", err)
		os.Exit(1)
	}
	channelStore, err := channel.OpenSQLite(cfg.StatePath)
	if err != nil {
		logger.Error("open state database", "error", err)
		os.Exit(1)
	}
	defer channelStore.Close()
	settingsStore, err := settings.OpenSQLite(cfg.StatePath)
	if err != nil {
		logger.Error("open settings database", "error", err)
		os.Exit(1)
	}
	defer settingsStore.Close()
	globalSettings, err := settingsStore.Get(context.Background())
	if err != nil {
		logger.Error("read global settings", "error", err)
		os.Exit(1)
	}
	managementAddress, activeManagementBind, managementPort, managementLocked, err := managementListener(cfg.ListenAddr, globalSettings.ManagementBindAddress)
	if err != nil {
		logger.Error("configure management listener", "error", err)
		os.Exit(1)
	}
	relaySupervisor := srtrelay.New(logger, "srt-live-transmit")
	defer relaySupervisor.Close()
	control := controlplane.NewCoordinator()
	channelService := channel.NewService(channelStore, mediaClient, settingsStore, relaySupervisor, control)
	settingsService := settings.NewService(settingsStore, mediaClient, channelService, control)
	compatibilityManager, err := compatibility.New(compatibility.Options{
		Logger: logger, Channels: channelService, MediaMTX: mediaClient,
		MediaRTSPURL: cfg.MediaMTXRTSPURL, EncoderThreads: cfg.EncoderThreads,
		WorkerCapacity: cfg.WorkerCapacity,
	})
	if err != nil {
		logger.Error("create compatibility manager", "error", err)
		os.Exit(1)
	}
	defer compatibilityManager.Close()
	logger.Info("compatibility capacity configured", "encoderThreads", cfg.EncoderThreads, "capacityUnits", cfg.WorkerCapacity)
	restartRequests := make(chan struct{}, 1)

	handler, err := httpapi.New(httpapi.Options{
		Logger:          logger,
		MediaMTX:        mediaClient,
		Channels:        channelService,
		Settings:        settingsService,
		Compatibility:   compatibilityManager,
		Relays:          relaySupervisor,
		MediaMTXWHEPURL: cfg.MediaMTXWHEPURL,
		Version:         version,
		StartedAt:       time.Now().UTC(),
		Management: httpapi.ManagementBinding{
			ActiveAddress: activeManagementBind,
			Port:          managementPort,
			Locked:        managementLocked,
		},
		Restart: func() {
			select {
			case restartRequests <- struct{}{}:
			default:
			}
		},
	})
	if err != nil {
		logger.Error("create HTTP handler", "error", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:              managementAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	healthMux := http.NewServeMux()
	healthMux.Handle("/healthz", handler)
	healthServer := &http.Server{
		Addr: cfg.HealthAddr, Handler: healthMux, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	controller := reconcile.New(logger, mediaClient, 5*time.Second, settingsService, channelService)
	go controller.Run(ctx)
	go compatibilityManager.Run(ctx)

	serverErr := make(chan error, 2)
	go func() {
		logger.Info("gateway listening", "address", managementAddress, "version", version)
		serverErr <- server.ListenAndServe()
	}()
	go func() {
		logger.Info("private health listener started", "address", cfg.HealthAddr)
		serverErr <- healthServer.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		logger.Info("gateway stopping")
	case <-restartRequests:
		logger.Info("gateway restart requested")
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server stopped", "error", err)
			os.Exit(1)
		}
		return
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	if err := healthServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("health server graceful shutdown failed", "error", err)
		os.Exit(1)
	}
}

func managementListener(configured, desired string) (address, activeBind string, port int, locked bool, err error) {
	host, portText, err := net.SplitHostPort(configured)
	if err != nil {
		return "", "", 0, false, err
	}
	activeBind, err = networkbind.Normalize(host, false)
	if err != nil {
		return "", "", 0, false, fmt.Errorf("GATEWAY_LISTEN_ADDR host: %w", err)
	}
	locked = host != ""
	if !locked {
		activeBind, err = networkbind.Normalize(desired, false)
		if err != nil {
			return "", "", 0, false, fmt.Errorf("saved management bind address: %w", err)
		}
	}
	port, err = strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", "", 0, false, fmt.Errorf("GATEWAY_LISTEN_ADDR port must be between 1 and 65535")
	}
	return net.JoinHostPort(networkbind.Host(activeBind), portText), activeBind, port, locked, nil
}
