import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import cron from "node-cron";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();
const MAX_RANGE_DAYS = 30; // อนุญาตสูงสุด 30 วันแบบ inclusive

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const DONKEY_DAY_CHANNEL = process.env.DONKEY_DAY_CHANNEL;
const REPORT_CHANNEL = process.env.REPORT_CHANNEL;
const TZ = process.env.TIMEZONE || "Asia/Bangkok";
const DATA_FILE = process.env.DATA_FILE || "./data/leaveData.json";

// โครงสร้างเก็บ: { "25/08/25": [ {name, reason, user, text} ] }
let leaveMessages = {};

// ---------- Persistence (load/save) ----------
function ensureDirFor(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadFromDisk() {
    try {
        ensureDirFor(DATA_FILE);
        if (!fs.existsSync(DATA_FILE)) {
            leaveMessages = {};
            fs.writeFileSync(DATA_FILE, JSON.stringify(leaveMessages, null, 2));
            return;
        }
        const raw = fs.readFileSync(DATA_FILE, "utf-8");
        leaveMessages = JSON.parse(raw || "{}");
        if (typeof leaveMessages !== "object" || Array.isArray(leaveMessages)) {
            // กันไฟล์พัง
            leaveMessages = {};
        }
        console.log("📦 Loaded leave data from disk.");
    } catch (e) {
        console.error("Failed to load data file, starting empty:", e);
        leaveMessages = {};
    }
}

let saveInFlight = false;
let pendingSave = false;

async function saveToDisk() {
    // เขียนแบบ atomic: เขียนไฟล์ชั่วคราวแล้ว rename ทับ
    if (saveInFlight) {
        pendingSave = true;
        return;
    }
    saveInFlight = true;
    try {
        ensureDirFor(DATA_FILE);
        const tmpPath = DATA_FILE + ".tmp";
        await fs.promises.writeFile(tmpPath, JSON.stringify(leaveMessages, null, 2), "utf-8");
        await fs.promises.rename(tmpPath, DATA_FILE);
        // console.log("💾 Saved leave data.");
    } catch (e) {
        console.error("Failed to save data:", e);
    } finally {
        saveInFlight = false;
        if (pendingSave) {
            pendingSave = false;
            // fire-and-forget
            saveToDisk();
        }
    }
}

// โหลดข้อมูลตอนเริ่ม
loadFromDisk();

// ---------- Regex / Utils ----------
const singleDateRegex = /\b([0-2]\d|3[0-1])\/(0\d|1[0-2])\/\d{2}\b/;
const rangeRegex = /\b([0-2]\d|3[0-1])\/(0\d|1[0-2])\/\d{2}\s*-\s*([0-2]\d|3[0-1])\/(0\d|1[0-2])\/\d{2}\b/;

function yyToYYYY(yy) {
    return 2000 + Number(yy);
}
function parseDDMMYY(s) {
    const [dd, mm, yy] = s.split("/").map((x) => parseInt(x, 10));
    return new Date(yyToYYYY(yy), mm - 1, dd);
}
function fmtDDMMYY(d) {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
}
function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}
function iterateDaysInclusive(start, end) {
    const days = [];
    let cur = startOfDay(start);
    const last = startOfDay(end);
    while (cur <= last) {
        days.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}

// ---------- Message Handler ----------
client.on("messageCreate", async (message) => {
    if (message.channelId !== DONKEY_DAY_CHANNEL || message.author.bot) return;

    const content = message.content.trim();

    // ===================
    // !help
    // ===================
    if (content === "!help") {
        const helpText = `
**📘 คำสั่งที่ใช้ได้**
\`!help\` - แสดงคู่มือการใช้งานบอท
\`!leaves\` - แสดงรายการคนลาทั้งหมดที่บันทึกไว้

**📥 วิธีคีย์ลา**
- ลาวันเดียว: \`ชื่อ เหตุผล dd/mm/yy\`
  ตัวอย่าง: \`ปัง ลาป่วย 26/08/25\`
  
- ลาหลายวัน: \`ชื่อ เหตุผล dd/mm/yy-dd/mm/yy\`
  ตัวอย่าง: \`ตูน ลากิจ 25/08/25-27/08/25\`
  
**กฎการกรอกข้อมูล:**
- ต้องใส่ **ชื่อ**, **เหตุผล**, และ **วันที่**
- วันที่ต้องไม่เป็นอดีต
- ช่วงลาหลายวันห้ามเกิน ${MAX_RANGE_DAYS} วัน
`;
        await message.reply(helpText);
        return;
    }

    // ===================
    // !leaves
    // ===================
    if (content === "!leaves") {
        if (Object.keys(leaveMessages).length === 0) {
            await message.reply("📂 ตอนนี้ไม่มีข้อมูลการลาที่บันทึกไว้");
            return;
        }

        let report = "📋 **รายการการลาทั้งหมด (ตามวันที่)**\n";
        const sortedDates = Object.keys(leaveMessages).sort((a, b) => {
            // แปลง dd/mm/yy เป็น date object เพื่อเรียง
            const [da, ma, ya] = a.split("/").map(Number);
            const [db, mb, yb] = b.split("/").map(Number);
            return new Date(2000 + ya, ma - 1, da) - new Date(2000 + yb, mb - 1, db);
        });

        for (const dateKey of sortedDates) {
            report += `\n📅 ${dateKey}\n`;
            leaveMessages[dateKey].forEach((entry, i) => {
                report += `${i + 1}. ${entry.name} (${entry.user}) - ${entry.reason}\n`;
            });
        }

        await message.reply(report.length > 2000 ? "📂 รายการยาวเกินไป!" : report);
        return;
    }

    // ✅ ถ้ามี "-" แต่ไม่ใช่ช่วงวันที่ที่ถูกต้อง → แจ้งเตือนและหยุด
    // ตัวอย่างที่ผิด: "25/08/25-27/08" (ขาดปีด้านหลัง), "25/08/25 - 27/8/25" (เดือน/วันไม่สองหลัก)
    if (content.includes("-") && !rangeRegex.test(content)) {
        await message.reply(
            "⚠️ รูปแบบช่วงวันไม่ถูกต้อง กรุณาใช้รูปแบบ `dd/mm/yy-dd/mm/yy` เช่น: `ตูน ลากิจ 25/08/25-27/08/25`"
        );
        return;
    }

    // ตรวจช่วงวันก่อน
    const rangeMatch = content.match(rangeRegex);
    let dates = [];

    if (rangeMatch) {
        const matchedDateText = rangeMatch[0];
        const [leftRaw, rightRaw] = matchedDateText.split("-").map((s) => s.trim());

        const start = parseDDMMYY(leftRaw);
        const end = parseDDMMYY(rightRaw);
        const today = startOfDay(new Date());

        if (isNaN(start) || isNaN(end)) {
            await message.reply("⚠️ วันที่ไม่ถูกต้อง กรุณาตรวจสอบรูปแบบ `dd/mm/yy-dd/mm/yy`");
            return;
        }
        if (start > end) {
            await message.reply("⚠️ ช่วงวันที่ไม่ถูกต้อง (วันเริ่มต้องไม่มากกว่าวันสิ้นสุด)");
            return;
        }
        if (start < today) {
            await message.reply("⚠️ ช่วงวันที่มีบางวันอยู่ในอดีต กรุณาใส่ช่วงที่เป็นปัจจุบันหรืออนาคต");
            return;
        }
        // ✅ เช็คความยาวช่วงไม่เกิน 14 วัน (inclusive)
        const days = iterateDaysInclusive(start, end);
        if (days.length > MAX_RANGE_DAYS) {
            await message.reply(`⚠️ ช่วงวันยาวเกินไป (สูงสุด ${MAX_RANGE_DAYS} วัน) — ตอนนี้ ${days.length} วัน`);
            return;
        }

        dates = days.map(fmtDDMMYY);

    } else {
        // ไม่ใช่ช่วง → ตรวจวันเดียว
        const single = content.match(singleDateRegex);
        if (!single) {
            await message.reply(
                "⚠️ กรุณาใส่วันที่ในรูปแบบ `dd/mm/yy` หรือช่วง `dd/mm/yy-dd/mm/yy` เช่น: `ปัง ลาป่วย 25/08/25` หรือ `ตูน ลากิจ 25/08/25-27/08/25`"
            );
            return;
        }
        const d = parseDDMMYY(single[0]);
        const today = startOfDay(new Date());
        if (d < today) {
            await message.reply(`⚠️ วันที่ ${single[0]} เป็นอดีตแล้ว กรุณาใส่วันที่ปัจจุบันหรืออนาคต`);
            return;
        }
        dates = [fmtDDMMYY(d)];
    }

    // ตัดวันที่ออกเพื่อแยกชื่อ + เหตุผล
    const textWithoutDate = content.replace(rangeRegex, "").replace(singleDateRegex, "").trim();
    const parts = textWithoutDate.split(/\s+/);

    if (parts.length < 2) {
        await message.reply(
            "⚠️ กรุณาใส่ชื่อ และเหตุผลการลา เช่น: `ปัง ลาป่วย 25/08/25` หรือ `ปัง ลากิจ 25/08/25-27/08/25`"
        );
        return;
    }

    const name = parts[0];
    const reason = parts.slice(1).join(" ");

    // บันทึกทุกวันในรายการ dates + save
    for (const dateKey of dates) {
        if (!leaveMessages[dateKey]) leaveMessages[dateKey] = [];
        leaveMessages[dateKey].push({
            name,
            reason,
            user: message.author.username,
            text: content,
        });
    }
    await saveToDisk();

    // ตอบกลับสรุปคำขอ (Embed)
    const embed = new EmbedBuilder()
        .setTitle("✅ บันทึกคำขอลาสำเร็จ")
        .addFields(
            { name: "ชื่อ", value: name, inline: true },
            { name: "เหตุผล", value: reason, inline: true },
            {
                name: dates.length > 1 ? "ช่วงวันที่ลา" : "วันที่ลา",
                value: dates.length > 1 ? `${dates[0]} - ${dates[dates.length - 1]} (${dates.length} วัน)` : dates[0],
            }
        )
        .setTimestamp(new Date())
        .setColor(0x22c55e);

    await message.reply({ embeds: [embed] });
});

// ---------- Daily Report ----------
async function sendDailyReport() {
    try {
        const channel = await client.channels.fetch(REPORT_CHANNEL);

        const now = new Date(); // cron คุม timezone ให้แล้ว
        const dd = String(now.getDate()).padStart(2, "0");
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const yy = String(now.getFullYear()).slice(-2);
        const todayKey = `${dd}/${mm}/${yy}`;

        const todayLeaves = leaveMessages[todayKey] || [];
        if (todayLeaves.length === 0) return;

        let report = `📋 รายงานการลา วันที่ ${todayKey}\n\n`;
        todayLeaves.forEach((msg, i) => {
            report += `${i + 1}. ${msg.name} (${msg.user}) - ${msg.reason}\n`;
        });

        await channel.send(report);

        // เคลียร์ของวันนั้นและบันทึก
        delete leaveMessages[todayKey];
        await saveToDisk();
    } catch (err) {
        console.error("Error sending report:", err);
    }
}

// ตั้งเวลา 9 โมงเช้าตาม TIMEZONE
cron.schedule("0 9 * * *", () => sendDailyReport(), { timezone: TZ });

client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(TOKEN);

// ปิดโปรเซสแล้วพยายามเซฟครั้งสุดท้าย
process.on("SIGINT", async () => {
    console.log("\nReceived SIGINT, saving data...");
    await saveToDisk();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    console.log("Received SIGTERM, saving data...");
    await saveToDisk();
    process.exit(0);
});
