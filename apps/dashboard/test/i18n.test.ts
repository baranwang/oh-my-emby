import { expect, it } from "vitest"

import en from "../messages/en.json"
import zhCN from "../messages/zh-CN.json"

it("keeps locale keys identical", () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
})
