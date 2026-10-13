import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt } from "../js/receipt.js";

const today = new Date(2026, 9, 13);

test("supermarket bill: picks NET TOTAL, not sub total, cash or change", () => {
  const text = `KEELLS SUPER
No 12, Galle Road, Matara
Tel: 0412222333
Date: 12/10/2026  Time 18:22
Bill No: 4455
Rice 5kg          1,450.00
Milk powder 400g  1,120.00
Sub Total         2,570.00
Discount            -70.00
NET TOTAL         2,500.00
Cash              3,000.00
Change              500.00
Thank you`;
  const r = parseReceipt(text, today);
  assert.equal(r.amount, 2500);
  assert.equal(r.date, "2026-10-12");
  assert.equal(r.merchant, "KEELLS SUPER");
  assert.equal(r.category, "shop");
  assert.equal(r.confidence, "high");
});

test("restaurant bill with total on the next line and Rs prefix", () => {
  const text = `Green Leaf Restaurant
2026-10-11
Fried rice x2   Rs. 1,800.00
Service charge 10%  180.00
TOTAL
Rs. 1,980.00`;
  const r = parseReceipt(text, today);
  assert.equal(r.amount, 1980);
  assert.equal(r.date, "2026-10-11");
  assert.equal(r.category, "food");
});

test("pharmacy bill with Grand Total and noisy OCR", () => {
  const text = `HEALTHGUARD PHARMACY
Inv No 778899   11-10-26
Panadol        120.00
Vitamin C      860.50
Grand Total :  980.50
Card ************1234`;
  const r = parseReceipt(text, today);
  assert.equal(r.amount, 980.5);
  assert.equal(r.date, "2026-10-11");
  assert.equal(r.category, "health");
});

test("no total word: falls back to largest amount with cents, low confidence", () => {
  const r = parseReceipt(`Some shop\nitem 200.00\nitem 350.00\n550.00\n`, today);
  assert.equal(r.amount, 550);
  assert.equal(r.confidence, "low");
});

test("nothing readable", () => {
  const r = parseReceipt("~~ ### ~~", today);
  assert.equal(r.amount, null);
  assert.equal(r.confidence, "none");
  assert.equal(r.date, null);
});

test("ignores future dates and phone numbers", () => {
  const r = parseReceipt(`Shop\nTel 0771234567\n25/12/2026\nTotal 450.00`, today);
  assert.equal(r.amount, 450);
  assert.equal(r.date, null);
});
