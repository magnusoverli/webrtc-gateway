package reconcile

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"webrtc-gateway/internal/mediamtx"
)

type fixedMediaInfo struct{}

func (fixedMediaInfo) Info(context.Context) (mediamtx.Info, error) {
	return mediamtx.Info{Started: "start-1"}, nil
}

type retryReconciler struct {
	mu        sync.Mutex
	full      int
	pending   int
	recovered chan struct{}
}

func (r *retryReconciler) Reconcile(context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.full++
	if r.full == 1 {
		return errors.New("temporary failure")
	}
	if r.full == 2 {
		close(r.recovered)
	}
	return nil
}

func (r *retryReconciler) ReconcilePending(context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending++
	return nil
}

func TestControllerRetriesFailedFullReconciliation(t *testing.T) {
	desired := &retryReconciler{recovered: make(chan struct{})}
	controller := New(slog.New(slog.NewTextHandler(io.Discard, nil)), fixedMediaInfo{}, time.Millisecond, desired)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		controller.Run(ctx)
		close(done)
	}()

	select {
	case <-desired.recovered:
	case <-time.After(time.Second):
		t.Fatal("full reconciliation was not retried")
	}
	cancel()
	<-done

	desired.mu.Lock()
	defer desired.mu.Unlock()
	if desired.full < 2 {
		t.Fatalf("reconcile calls = full %d, pending %d", desired.full, desired.pending)
	}
}
