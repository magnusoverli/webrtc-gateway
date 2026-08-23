package controlplane

import "context"

type scopeKey struct{}

// Coordinator serializes desired-state mutations within a Gateway process.
type Coordinator struct {
	permit chan struct{}
}

func NewCoordinator() *Coordinator {
	coordinator := &Coordinator{permit: make(chan struct{}, 1)}
	coordinator.permit <- struct{}{}
	return coordinator
}

func (c *Coordinator) Acquire(ctx context.Context) (context.Context, func(), error) {
	if current, ok := ctx.Value(scopeKey{}).(*Coordinator); ok && current == c {
		return ctx, func() {}, nil
	}

	select {
	case <-ctx.Done():
		return ctx, nil, ctx.Err()
	case <-c.permit:
	}

	return context.WithValue(ctx, scopeKey{}, c), func() {
		c.permit <- struct{}{}
	}, nil
}
