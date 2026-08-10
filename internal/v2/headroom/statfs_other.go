//go:build !unix

package headroom

// statfsAvail has no implementation off unix. See errUnsupported: this is a
// sampling failure, which Check treats as "keep the previous state and log it",
// so a build for a platform this server does not target still compiles and still
// serves rather than refusing every write.
func statfsAvail(string) (uint64, error) { return 0, errUnsupported }
