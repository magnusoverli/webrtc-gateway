package reconcile

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"webrtc-gateway/internal/mediamtx"
)

type mediaInfoReader interface {
	Info(context.Context) (mediamtx.Info, error)
}

type desiredStateReconciler interface {
	Reconcile(context.Context) error
	ReconcilePending(context.Context) error
}

type Controller struct {
	logger   *slog.Logger
	media    mediaInfoReader
	desired  []desiredStateReconciler
	interval time.Duration
}

func New(logger *slog.Logger, media mediaInfoReader, interval time.Duration, desired ...desiredStateReconciler) *Controller {
	return &Controller{logger: logger, media: media, desired: desired, interval: interval}
}

func (c *Controller) Run(ctx context.Context) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	lastMediaStart := ""
	for {
		checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		info, err := c.media.Info(checkCtx)
		if err != nil {
			c.logger.Warn("MediaMTX reconciliation deferred", "error", err)
		} else if info.Started != lastMediaStart {
			if err := c.reconcile(checkCtx, false); err != nil {
				c.logger.Warn("desired-state reconciliation incomplete", "error", err)
			} else {
				c.logger.Info("desired state reconciled", "mediaStarted", info.Started)
				lastMediaStart = info.Started
			}
		} else if err := c.reconcile(checkCtx, true); err != nil {
			c.logger.Warn("pending desired-state reconciliation incomplete", "error", err)
		}
		cancel()

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Controller) reconcile(ctx context.Context, pendingOnly bool) error {
	var failures []error
	for _, desired := range c.desired {
		var err error
		if pendingOnly {
			err = desired.ReconcilePending(ctx)
		} else {
			err = desired.Reconcile(ctx)
		}
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
