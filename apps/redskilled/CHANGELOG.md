# @reddb-io/redskilled

## 3.6.0

### Patch Changes

- Updated dependencies [bb13751]
  - @reddb-io/redskilled-render@3.6.0
  - @reddb-io/github@3.6.0
  - @reddb-io/shared@3.6.0
  - @reddb-io/build-info@3.6.0

## 3.5.1

### Patch Changes

- @reddb-io/github@3.5.1
- @reddb-io/shared@3.5.1
- @reddb-io/build-info@3.5.1
- @reddb-io/redskilled-render@3.5.1

## 3.5.0

### Patch Changes

- @reddb-io/github@3.5.0
- @reddb-io/shared@3.5.0
- @reddb-io/build-info@3.5.0
- @reddb-io/redskilled-render@3.5.0

## 3.4.3

### Patch Changes

- eea6d66: Poll repository activity and queue discovery through conditional Octokit REST reads, preserving the last answer on `304 Not Modified` while keeping quota and network failures distinct.
- Updated dependencies [bda5bd7]
  - @reddb-io/github@3.4.3
  - @reddb-io/shared@3.4.3
  - @reddb-io/build-info@3.4.3
  - @reddb-io/redskilled-render@3.4.3

## 3.4.2

### Patch Changes

- @reddb-io/github@3.4.2
- @reddb-io/shared@3.4.2
- @reddb-io/build-info@3.4.2
- @reddb-io/redskilled-render@3.4.2

## 3.4.1

### Patch Changes

- c979efe: Distinguish never-registered, lapsed, deliberately stopped, and orphaned-daemon project histories in statusline and renewal diagnostics.
- Updated dependencies [c979efe]
  - @reddb-io/redskilled-render@3.4.1
  - @reddb-io/github@3.4.1
  - @reddb-io/shared@3.4.1
  - @reddb-io/build-info@3.4.1

## 3.4.0

### Patch Changes

- @reddb-io/github@3.4.0
- @reddb-io/shared@3.4.0
- @reddb-io/build-info@3.4.0
- @reddb-io/redskilled-render@3.4.0

## 3.3.24

### Patch Changes

- @reddb-io/github@3.3.24
- @reddb-io/shared@3.3.24
- @reddb-io/build-info@3.3.24
- @reddb-io/redskilled-render@3.3.24

## 3.3.23

### Patch Changes

- @reddb-io/github@3.3.23
- @reddb-io/shared@3.3.23
- @reddb-io/build-info@3.3.23
- @reddb-io/redskilled-render@3.3.23

## 3.3.22

### Patch Changes

- 8bbd8d4: Ask the kernel who owns the socket, not a 250ms clock

  `bindExclusive` resolved an ambiguous `EADDRINUSE` — a live peer and the socket
  file a crash left behind look identical on disk — by pinging the path and
  treating silence as debris to unlink. A ping asks whether the owner is HEALTHY,
  and health is not title: a daemon busy on a long request, or hung in a shutdown
  drain, fails a 250ms ping while owning its socket completely. Reading that
  `false` as an absent owner unlinked live sockets out from under running daemons,
  which then went on believing they were the machine's single arbiter.

  One host recorded **1166 daemon births in a day**, 985 of them living two seconds
  or less, with **four daemons `serving` simultaneously**. Each theft also dropped
  the standing project registrations onto a daemon nobody would reach again.

  Ownership is now asked of the kernel: a `connect()` that succeeds proves a
  listener is bound, whether or not it ever replies; only `ECONNREFUSED`/`ENOENT`
  proves the inode is debris. An unresolved probe keeps the path, because the two
  mistakes do not cost the same — refusing to start loses one daemon that says
  why, and unlinking a live socket loses every client that came after it, silently.
  The lease and the machine claim are consulted as a second belt: a probe is not
  owed the last word over two records that already name a live pid.
  - @reddb-io/github@3.3.22
  - @reddb-io/shared@3.3.22
  - @reddb-io/build-info@3.3.22
  - @reddb-io/redskilled-render@3.3.22

## 3.3.21

### Patch Changes

- @reddb-io/github@3.3.21
- @reddb-io/shared@3.3.21
- @reddb-io/build-info@3.3.21
- @reddb-io/redskilled-render@3.3.21

## 3.3.20

### Patch Changes

- @reddb-io/github@3.3.20
- @reddb-io/shared@3.3.20
- @reddb-io/build-info@3.3.20
- @reddb-io/redskilled-render@3.3.20

## 3.3.19

### Patch Changes

- @reddb-io/github@3.3.19
- @reddb-io/shared@3.3.19
- @reddb-io/build-info@3.3.19
- @reddb-io/redskilled-render@3.3.19

## 3.3.18

### Patch Changes

- @reddb-io/github@3.3.18
- @reddb-io/shared@3.3.18
- @reddb-io/build-info@3.3.18
- @reddb-io/redskilled-render@3.3.18

## 3.3.17

### Patch Changes

- @reddb-io/github@3.3.17
- @reddb-io/shared@3.3.17
- @reddb-io/build-info@3.3.17
- @reddb-io/redskilled-render@3.3.17

## 3.3.16

### Patch Changes

- @reddb-io/github@3.3.16
- @reddb-io/shared@3.3.16
- @reddb-io/build-info@3.3.16
- @reddb-io/redskilled-render@3.3.16

## 3.3.15

### Patch Changes

- @reddb-io/github@3.3.15
- @reddb-io/shared@3.3.15
- @reddb-io/build-info@3.3.15
- @reddb-io/redskilled-render@3.3.15

## 3.3.14

### Patch Changes

- @reddb-io/github@3.3.14
- @reddb-io/shared@3.3.14
- @reddb-io/build-info@3.3.14
- @reddb-io/redskilled-render@3.3.14

## 3.3.13

### Patch Changes

- @reddb-io/github@3.3.13
- @reddb-io/shared@3.3.13
- @reddb-io/build-info@3.3.13
- @reddb-io/redskilled-render@3.3.13

## 3.3.12

### Patch Changes

- @reddb-io/github@3.3.12
- @reddb-io/shared@3.3.12
- @reddb-io/build-info@3.3.12
