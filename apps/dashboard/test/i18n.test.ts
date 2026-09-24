import { expect, it } from "vitest"

import en from "../messages/en.json"
import zhCN from "../messages/zh-CN.json"

it("keeps locale keys identical", () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
})

it.each([en, zhCN])("keeps shell and Overview actions translated", (messages) => {
  expect([
    messages.account_menu,
    messages.overview_loading,
    messages.overview_load_failed,
    messages.overview_setup_server_title,
    messages.overview_healthy_title,
    messages.overview_sync_attention_title
  ].every((message) => typeof message === "string" && message.length > 0)).toBe(true)
})
