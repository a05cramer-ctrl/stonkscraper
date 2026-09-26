self.__MIDDLEWARE_MATCHERS = [
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!api\\/|_next\\/|restricted$|.*\\..*).*))(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/((?!api/|_next/|restricted$|.*\\..*).*)"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/launch(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/launch"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/launch-fast(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/launch-fast"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/launch-prepare(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/launch-prepare"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/launch-quote(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/launch-quote"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/launchlab-launch(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/launchlab-launch"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/submit-launch-payment(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/submit-launch-payment"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/send-transaction(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/send-transaction"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/custom-quote-token(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/custom-quote-token"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/upload(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/upload"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/airdrop-preview(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/airdrop-preview"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/airdrop-prewarm(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/airdrop-prewarm"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/creator-fees(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/creator-fees"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/public\\/v1\\/launches\\/prepare(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/public/v1/launches/prepare"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/public\\/v1\\/launches\\/submit(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/public/v1/launches/submit"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/public\\/v1\\/launchlab\\/pricing(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/public/v1/launchlab/pricing"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/public\\/v1\\/tokens(?:\\/([^\\/#\\?]+?))\\/fees\\/claim\\/prepare(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/public/v1/tokens/:mint/fees/claim/prepare"
  },
  {
    "regexp": "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/api\\/public\\/v1\\/tokens(?:\\/([^\\/#\\?]+?))\\/fees\\/claim\\/submit(\\.json|\\.rsc|\\.segments\\/.+\\.segment\\.rsc)?[\\/#\\?]?$",
    "originalSource": "/api/public/v1/tokens/:mint/fees/claim/submit"
  }
];self.__MIDDLEWARE_MATCHERS_CB && self.__MIDDLEWARE_MATCHERS_CB()