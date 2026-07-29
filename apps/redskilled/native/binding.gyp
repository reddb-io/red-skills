{
  "comment": [
    "The Job Object addon's build description (#2781, mechanism decided on #2780).",
    "It lives under native/ rather than at the package root DELIBERATELY: a root",
    "binding.gyp makes every install of this workspace try to compile an addon,",
    "and this package ships as pure JavaScript on Linux and macOS, where the",
    "addon does not even exist. Build it explicitly with `pnpm build:native`,",
    "which is the node-gyp fallback the loader looks for when no prebuild",
    "matches the host."
  ],
  "targets": [
    {
      "target_name": "redskilled-job-object",
      "sources": [],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "sources": ["job-object.cc"],
            "libraries": ["-lkernel32.lib"],
            "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE"]
          }
        ]
      ]
    }
  ]
}
