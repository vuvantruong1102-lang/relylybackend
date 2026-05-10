// scripts/create-template-xlsx.js - tạo file template để user tải
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";

const data = [
  {
    display_name: "Shop Áo Quần Nam",
    page_id: "123456789012345",
    page_access_token: "EAAxxxxx_REPLACE_WITH_REAL_TOKEN",
    default_shopee_link: "https://shopee.vn/yourshop1",
  },
  {
    display_name: "Mỹ Phẩm Nature",
    page_id: "987654321098765",
    page_access_token: "EAAyyyyy_REPLACE_WITH_REAL_TOKEN",
    default_shopee_link: "",
  },
];

const ws = XLSX.utils.json_to_sheet(data);
ws["!cols"] = [
  { wch: 25 },
  { wch: 22 },
  { wch: 50 },
  { wch: 35 },
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Pages");
XLSX.writeFile(wb, "scripts/pages-template.xlsx");
console.log("✓ Created scripts/pages-template.xlsx");
