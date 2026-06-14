package parse

import (
	"context"

	"ledger/internal/store"
)

// Reprocess re-runs the cascade over retained raw email, retrying unparsed AND
// low_confidence rows, optionally filtered to a bank/sender substring. It makes
// *Processor satisfy server.Reprocessor.
func (p *Processor) Reprocess(ctx context.Context, bank string) (int, error) {
	return p.ProcessPending(ctx, store.SelectForParseOpts{OnlyUnparsed: false, FromLike: bank})
}
