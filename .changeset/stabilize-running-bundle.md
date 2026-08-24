---
"@reddb-io/redskilled": patch
---

The serving daemon files its own running bundle (and the statusline sibling) into the stable lane at boot, and a supervised boot rewrites a pinned npx ExecStart onto that stable copy — the lane tracks the served version again instead of freezing at the last file-resolved release, and the next boot needs neither the npm cache nor the network.
