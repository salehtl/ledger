// Package webui embeds the built v2 PWA and serves it from ledgerd, on the
// SAME listener as /api/v1/*.
//
// Sharing the origin is the point, not a convenience: a passkey ceremony is
// bound to the origin the browser reports, so a PWA served from somewhere else
// would need CORS on every sync request, a second entry in auth.rp_origins, and
// a cookie/bearer story that survives a cross-site fetch. One origin removes
// all three.
//
// The dist/ directory is produced by `cd web && bun run build` (vite's
// build.outDir points here) and is COMMITTED, on the same terms as v1's
// internal/web/dist: //go:embed fails the Go build outright if the directory is
// missing, so a fresh clone must not need Node to compile the binary.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the embedded bundle rooted at dist/, ready for Handler.
func FS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}
