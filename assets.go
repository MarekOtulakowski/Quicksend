// Package quicksend embeds the PWA frontend so it can be served directly
// from the relay binary without any external files at runtime.
package quicksend

import "embed"

//go:embed all:web
var WebFS embed.FS
