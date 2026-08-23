package controlplane

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCoordinatorSerializesAndAllowsScopedReentry(t *testing.T) {
	coordinator := NewCoordinator()
	ctx, release, err := coordinator.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	nested, nestedRelease, err := coordinator.Acquire(ctx)
	if err != nil || nested == nil {
		t.Fatalf("nested Acquire() = %v, %v", nested, err)
	}
	nestedRelease()

	waitCtx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, _, err := coordinator.Acquire(waitCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked Acquire() error = %v", err)
	}
}
