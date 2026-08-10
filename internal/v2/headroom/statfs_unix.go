//go:build unix

package headroom

import "syscall"

// statfsAvail reports the bytes available on the filesystem holding path.
//
// Bavail, NOT Bfree. The difference is the reserved fraction (5% by default on
// ext4) that only root may spend, and it is exactly the space the operator's own
// recovery depends on: counting it as free would let the fuse report headroom
// that Postgres — which does not run as root — cannot use.
func statfsAvail(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}
