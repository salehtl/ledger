// Package web embeds the built frontend bundle so the single binary serves the
// SPA from its own filesystem. The dist/ directory is produced by the Vite build
// in frontend/ (run `bun run build` there before `go build`).
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the embedded bundle rooted at the dist directory, ready to hand to
// http.FileServer(http.FS(...)).
func FS() (fs.FS, error) {
	return fs.Sub(distFS, "dist")
}
