import {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
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
    if (content === "!help" || content === "!ช่วย") {
        const helpEmbed = new EmbedBuilder()
            .setTitle("📘 คู่มือการใช้งานบอทลา")
            .setColor(0x3b82f6)
            .addFields(
                {
                    name: "📌 คำสั่งทั้งหมด",
                    value: [
                        "`!help` หรือ `!ช่วย` — แสดงคู่มือนี้",
                        "`!leave` หรือ `!ลา` — เปิดฟอร์มเพิ่มวันลา (กรอกผ่าน Popup)",
                        "`!leaves` หรือ `!ลาทั้งหมด` — แสดงรายการคนลาทั้งหมด",
                        "`!editleaves` หรือ `!แก้ไขการลา` — เปิดเมนูแก้ไข / ลบการลา",
                    ].join("\n"),
                },
                {
                    name: "📝 เพิ่มวันลา",
                    value: "พิมพ์ `!leave` หรือ `!ลา` → กดปุ่ม 📝 → กรอกชื่อ, เหตุผล, วันที่ ใน Popup",
                },
                {
                    name: "✏️ แก้ไข / 🗑️ ลบการลา",
                    value: [
                        "พิมพ์ `!editleaves` หรือ `!แก้ไขการลา` → เลือกรายการจาก Dropdown",
                        "→ กดปุ่ม ✏️ แก้ไข (เปลี่ยนเหตุผล/วันที่ได้)",
                        "→ กดปุ่ม 🗑️ ลบ (ลบทันที)",
                    ].join("\n"),
                },
                {
                    name: "📋 ดูรายการลา",
                    value: "พิมพ์ `!leaves` หรือ `!ลาทั้งหมด` → แสดง Embed แยกตามวันที่",
                },
                {
                    name: "⏰ รายงานอัตโนมัติ",
                    value: [
                        "🕘 **09:00** — รายงานการลาของวันนั้น",
                        "🕐 **13:00** — รายงานเพิ่มเติม (เฉพาะคนที่เพิ่มหลัง 9 โมง)",
                    ].join("\n"),
                },
                {
                    name: "⚠️ กฎการกรอกข้อมูล",
                    value: [
                        "• ต้องใส่ **ชื่อ**, **เหตุผล**, และ **วันที่**",
                        "• วันที่ต้องไม่เป็นอดีต",
                        `• ช่วงลาหลายวันห้ามเกิน **${MAX_RANGE_DAYS} วัน**`,
                    ].join("\n"),
                }
            )
            .setTimestamp(new Date());

        await message.reply({ embeds: [helpEmbed] });
        return;
    }

    // ===================
    // !leave (UI-based add leave)
    // ===================
    if (content === "!leave" || content === "!ลา") {
        const addBtn = new ButtonBuilder()
            .setCustomId("add_leave_btn")
            .setLabel("เพิ่มวันลา")
            .setEmoji("📝")
            .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(addBtn);

        const embed = new EmbedBuilder()
            .setTitle("📝 เพิ่มวันลา")
            .setDescription("กดปุ่มด้านล่างเพื่อกรอกข้อมูลการลา")
            .setColor(0x22c55e);

        await message.reply({ embeds: [embed], components: [row] });
        return;
    }

    // ===================
    // !leaves
    // ===================
    if (content === "!leaves" || content === "!ลาทั้งหมด") {
        if (Object.keys(leaveMessages).length === 0) {
            await message.reply("📂 ตอนนี้ไม่มีข้อมูลการลาที่บันทึกไว้");
            return;
        }

        const sortedDates = Object.keys(leaveMessages).sort((a, b) => {
            const [da, ma, ya] = a.split("/").map(Number);
            const [db, mb, yb] = b.split("/").map(Number);
            return new Date(2000 + ya, ma - 1, da) - new Date(2000 + yb, mb - 1, db);
        });

        const embeds = [];
        for (const dateKey of sortedDates) {
            const entries = leaveMessages[dateKey];
            const rows = entries.map((e, i) =>
                `\`${String(i + 1).padStart(2, " ")}.\` **${e.name}** — ${e.reason}`
            );

            const embed = new EmbedBuilder()
                .setTitle(`📅 ${dateKey}`)
                .setDescription(rows.join("\n"))
                .setColor(0x3b82f6)
                .setFooter({ text: `${entries.length} คนลา` });

            embeds.push(embed);
        }

        // Discord ส่ง embeds ได้สูงสุด 10 ต่อข้อความ (header นับรวมด้วย)
        const header = new EmbedBuilder()
            .setTitle("📋 รายการการลาทั้งหมด")
            .setDescription(`ทั้งหมด **${sortedDates.length}** วัน`)
            .setColor(0x1d4ed8)
            .setTimestamp(new Date());

        const allEmbeds = [header, ...embeds];
        const chunks = [];
        for (let i = 0; i < allEmbeds.length; i += 10) {
            chunks.push(allEmbeds.slice(i, i + 10));
        }

        await message.reply({ embeds: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
            await message.channel.send({ embeds: chunks[i] });
        }
        return;
    }

    // ===================
    // !editleaves (UI-based edit/delete)
    // ===================
    if (content === "!editleaves" || content === "!แก้ไขการลา") {
        // รวบรวมรายการลาทั้งหมด (unique name+date)
        const entries = [];
        const seen = new Set();

        const sortedDates = Object.keys(leaveMessages).sort((a, b) => {
            const [da, ma, ya] = a.split("/").map(Number);
            const [db, mb, yb] = b.split("/").map(Number);
            return new Date(2000 + ya, ma - 1, da) - new Date(2000 + yb, mb - 1, db);
        });

        for (const dateKey of sortedDates) {
            for (const entry of leaveMessages[dateKey]) {
                const key = `${entry.name}::${dateKey}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    entries.push({ name: entry.name, reason: entry.reason, date: dateKey });
                }
            }
        }

        if (entries.length === 0) {
            await message.reply("📂 ไม่มีข้อมูลการลาให้จัดการ");
            return;
        }

        const options = entries.slice(0, 25).map((e) => ({
            label: `${e.name} — ${e.reason}`.slice(0, 100),
            description: `📅 ${e.date}`,
            value: `${e.name}::${e.date}`,
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("manage_select")
            .setPlaceholder("🔍 เลือกรายการลาที่ต้องการจัดการ...")
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setTitle("📋 จัดการข้อมูลการลา")
            .setDescription(
                entries.length > 25
                    ? `แสดง 25 จาก ${entries.length} รายการ — เลือกจาก Dropdown ด้านล่าง`
                    : "เลือกรายการลาจาก Dropdown ด้านล่างเพื่อแก้ไขหรือลบ"
            )
            .setColor(0x3b82f6);

        await message.reply({ embeds: [embed], components: [row] });
        return;
    }
});

// ---------- Interaction Handler (UI: Select Menu / Buttons / Modal) ----------
client.on("interactionCreate", async (interaction) => {
    try {
        // ===== Button: กรอกใหม่ (retry) → ลบปุ่มแล้วเปิด Modal =====
        if (interaction.isButton() && interaction.customId.startsWith("retry_leave::")) {
            const encoded = interaction.customId.split("::")[1];
            let prevName = "";
            let prevReason = "";
            try {
                const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
                prevName = parsed.n || "";
                prevReason = parsed.r || "";
            } catch (_) { }

            // ลบปุ่มกรอกใหม่ออกก่อน
            try {
                await interaction.message?.edit({ components: [] });
            } catch (_) { }

            const modal = new ModalBuilder()
                .setCustomId("modal_add_leave")
                .setTitle("📝 เพิ่มวันลา");

            const nameInput = new TextInputBuilder()
                .setCustomId("leave_name")
                .setLabel("ชื่อ")
                .setPlaceholder("เช่น ปัง, ตูน")
                .setStyle(TextInputStyle.Short)
                .setValue(prevName)
                .setRequired(true)
                .setMaxLength(50);

            const reasonInput = new TextInputBuilder()
                .setCustomId("leave_reason")
                .setLabel("เหตุผลการลา")
                .setPlaceholder("เช่น ลาป่วย, ลากิจ, ลาพักร้อน")
                .setStyle(TextInputStyle.Short)
                .setValue(prevReason)
                .setRequired(true)
                .setMaxLength(200);

            const dateInput = new TextInputBuilder()
                .setCustomId("leave_date")
                .setLabel("วันที่ลา (dd/mm/yy หรือ dd/mm/yy-dd/mm/yy)")
                .setPlaceholder("เช่น 25/08/25 หรือ 25/08/25-27/08/25")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(8)
                .setMaxLength(17);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(reasonInput),
                new ActionRowBuilder().addComponents(dateInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // ===== Button: เพิ่มวันลา → เปิด Modal =====
        if (interaction.isButton() && interaction.customId === "add_leave_btn") {
            const modal = new ModalBuilder()
                .setCustomId("modal_add_leave")
                .setTitle("📝 เพิ่มวันลา");

            const nameInput = new TextInputBuilder()
                .setCustomId("leave_name")
                .setLabel("ชื่อ")
                .setPlaceholder("เช่น ปัง, ตูน")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(50);

            const reasonInput = new TextInputBuilder()
                .setCustomId("leave_reason")
                .setLabel("เหตุผลการลา")
                .setPlaceholder("เช่น ลาป่วย, ลากิจ, ลาพักร้อน")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(200);

            const dateInput = new TextInputBuilder()
                .setCustomId("leave_date")
                .setLabel("วันที่ลา (dd/mm/yy หรือ dd/mm/yy-dd/mm/yy)")
                .setPlaceholder("เช่น 25/08/25 หรือ 25/08/25-27/08/25")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(8)
                .setMaxLength(17);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(reasonInput),
                new ActionRowBuilder().addComponents(dateInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // ===== Modal Submit: เพิ่มวันลา =====
        if (interaction.isModalSubmit() && interaction.customId === "modal_add_leave") {
            const name = interaction.fields.getTextInputValue("leave_name").trim();
            const reason = interaction.fields.getTextInputValue("leave_reason").trim();
            const dateRaw = interaction.fields.getTextInputValue("leave_date").trim();

            // --- Helper: ส่ง error พร้อมปุ่มกรอกใหม่ (เก็บข้อมูลเดิม) ---
            const replyError = async (msg) => {
                const retryData = Buffer.from(JSON.stringify({ n: name, r: reason })).toString("base64").slice(0, 80);
                const retryBtn = new ButtonBuilder()
                    .setCustomId(`retry_leave::${retryData}`)
                    .setLabel("กรอกใหม่")
                    .setEmoji("🔄")
                    .setStyle(ButtonStyle.Primary);
                const row = new ActionRowBuilder().addComponents(retryBtn);
                await interaction.reply({
                    content: `${msg}\n\n📌 **ข้อมูลที่กรอก:** ชื่อ: \`${name}\` | เหตุผล: \`${reason}\` | วันที่: \`${dateRaw}\``,
                    components: [row],
                    ephemeral: true,
                });
            };

            if (!name || !reason) {
                await replyError("⚠️ ชื่อและเหตุผลห้ามว่าง");
                return;
            }

            let dates = [];
            const rmatch = dateRaw.match(rangeRegex);
            const smatch = dateRaw.match(singleDateRegex);

            if (rmatch) {
                const [leftRaw, rightRaw] = rmatch[0].split("-").map((s) => s.trim());
                const start = parseDDMMYY(leftRaw);
                const end = parseDDMMYY(rightRaw);
                const today = startOfDay(new Date());

                if (isNaN(start) || isNaN(end)) {
                    await replyError("⚠️ วันที่ไม่ถูกต้อง กรุณาใช้รูปแบบ `dd/mm/yy-dd/mm/yy` เช่น `25/08/25-27/08/25`");
                    return;
                }
                if (start > end) {
                    await replyError("⚠️ วันเริ่มต้องไม่มากกว่าวันสิ้นสุด");
                    return;
                }
                if (start < today) {
                    await replyError("⚠️ วันที่ต้องเป็นวันนี้หรืออนาคต ห้ามเป็นอดีต");
                    return;
                }
                const days = iterateDaysInclusive(start, end);
                if (days.length > MAX_RANGE_DAYS) {
                    await replyError(`⚠️ ช่วงวันยาวเกินไป (สูงสุด ${MAX_RANGE_DAYS} วัน) — ตอนนี้ ${days.length} วัน`);
                    return;
                }
                dates = days.map(fmtDDMMYY);
            } else if (smatch) {
                const d = parseDDMMYY(smatch[0]);
                const today = startOfDay(new Date());
                if (isNaN(d)) {
                    await replyError("⚠️ วันที่ไม่ถูกต้อง กรุณาตรวจสอบ");
                    return;
                }
                if (d < today) {
                    await replyError(`⚠️ วันที่ \`${smatch[0]}\` เป็นอดีตแล้ว กรุณาใส่วันที่ปัจจุบันหรืออนาคต`);
                    return;
                }
                dates = [fmtDDMMYY(d)];
            } else {
                await replyError("⚠️ รูปแบบวันที่ไม่ถูกต้อง กรุณาใช้ `dd/mm/yy` เช่น `10/04/26` หรือ `dd/mm/yy-dd/mm/yy` เช่น `10/04/26-12/04/26`");
                return;
            }

            // บันทึก
            for (const dateKey of dates) {
                if (!leaveMessages[dateKey]) leaveMessages[dateKey] = [];
                leaveMessages[dateKey].push({
                    name,
                    reason,
                    user: interaction.user.username,
                    text: `${name} ${reason} ${dateRaw}`,
                });
            }
            await saveToDisk();

            // ลบปุ่มจากข้อความ !leave เดิม (ถ้ามี)
            try {
                const ch = interaction.channel;
                if (ch) {
                    const msgs = await ch.messages.fetch({ limit: 10 });
                    const leaveMsg = msgs.find(
                        (m) => m.author.id === interaction.client.user.id &&
                            m.components?.length > 0 &&
                            m.components[0]?.components?.some((c) => c.customId === "add_leave_btn")
                    );
                    if (leaveMsg) await leaveMsg.edit({ components: [] });
                }
            } catch (_) { }

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

            await interaction.reply({ embeds: [embed] });
            return;
        }

        // ===== Select Menu: เลือกรายการลา =====
        if (interaction.isStringSelectMenu() && interaction.customId === "manage_select") {
            const [name, date] = interaction.values[0].split("::");
            const entries = leaveMessages[date]?.filter((e) => e.name === name);

            if (!entries || entries.length === 0) {
                await interaction.update({
                    content: "⚠️ ไม่พบข้อมูลนี้แล้ว (อาจถูกลบไปแล้ว)",
                    embeds: [],
                    components: [],
                });
                return;
            }

            const entry = entries[0];
            const embed = new EmbedBuilder()
                .setTitle("📝 จัดการการลา")
                .setDescription("เลือกสิ่งที่ต้องการทำ:")
                .addFields(
                    { name: "ชื่อ", value: entry.name, inline: true },
                    { name: "เหตุผล", value: entry.reason, inline: true },
                    { name: "วันที่", value: date, inline: true }
                )
                .setColor(0x3b82f6);

            const editBtn = new ButtonBuilder()
                .setCustomId(`edit_leave::${name}::${date}`)
                .setLabel("แก้ไข")
                .setEmoji("✏️")
                .setStyle(ButtonStyle.Primary);

            const deleteBtn = new ButtonBuilder()
                .setCustomId(`delete_leave::${name}::${date}`)
                .setLabel("ลบการลา")
                .setEmoji("🗑️")
                .setStyle(ButtonStyle.Danger);

            const cancelBtn = new ButtonBuilder()
                .setCustomId("manage_cancel")
                .setLabel("ยกเลิก")
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder().addComponents(editBtn, deleteBtn, cancelBtn);

            await interaction.update({ content: null, embeds: [embed], components: [row] });
            return;
        }

        // ===== Button: แก้ไข → เปิด Modal =====
        if (interaction.isButton() && interaction.customId.startsWith("edit_leave::")) {
            const parts = interaction.customId.split("::");
            const name = parts[1];
            const date = parts[2];

            const entry = leaveMessages[date]?.find((e) => e.name === name);

            const modal = new ModalBuilder()
                .setCustomId(`modal_edit::${name}::${date}`)
                .setTitle(`✏️ แก้ไขการลาของ ${name}`);

            const reasonInput = new TextInputBuilder()
                .setCustomId("new_reason")
                .setLabel("เหตุผลการลา")
                .setStyle(TextInputStyle.Short)
                .setValue(entry?.reason || "")
                .setRequired(true)
                .setMaxLength(200);

            const dateInput = new TextInputBuilder()
                .setCustomId("new_date")
                .setLabel("วันที่ลา (dd/mm/yy) เช่น 25/08/25")
                .setStyle(TextInputStyle.Short)
                .setValue(date)
                .setPlaceholder("dd/mm/yy")
                .setRequired(true)
                .setMinLength(8)
                .setMaxLength(8);

            modal.addComponents(
                new ActionRowBuilder().addComponents(reasonInput),
                new ActionRowBuilder().addComponents(dateInput)
            );
            await interaction.showModal(modal);
            return;
        }

        // ===== Button: ลบ → ลบทันที =====
        if (interaction.isButton() && interaction.customId.startsWith("delete_leave::")) {
            const parts = interaction.customId.split("::");
            const name = parts[1];
            const date = parts[2];

            let deletedCount = 0;
            if (leaveMessages[date]) {
                const before = leaveMessages[date].length;
                leaveMessages[date] = leaveMessages[date].filter((e) => e.name !== name);
                deletedCount = before - leaveMessages[date].length;
                if (leaveMessages[date].length === 0) delete leaveMessages[date];
            }

            if (deletedCount > 0) {
                await saveToDisk();
                const embed = new EmbedBuilder()
                    .setTitle("🗑️ ลบข้อมูลการลาสำเร็จ")
                    .addFields(
                        { name: "ชื่อ", value: name, inline: true },
                        { name: "วันที่", value: date, inline: true }
                    )
                    .setTimestamp(new Date())
                    .setColor(0xef4444);

                await interaction.update({ content: null, embeds: [embed], components: [] });
            } else {
                await interaction.update({
                    content: "⚠️ ไม่พบข้อมูลนี้แล้ว (อาจถูกลบไปแล้ว)",
                    embeds: [],
                    components: [],
                });
            }
            return;
        }

        // ===== Button: ยกเลิก =====
        if (interaction.isButton() && interaction.customId === "manage_cancel") {
            await interaction.update({
                content: "❌ ยกเลิกการจัดการ",
                embeds: [],
                components: [],
            });
            return;
        }

        // ===== Modal Submit: บันทึกเหตุผล/วันที่ใหม่ =====
        if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_edit::")) {
            const parts = interaction.customId.split("::");
            const name = parts[1];
            const oldDate = parts[2];
            const newReason = interaction.fields.getTextInputValue("new_reason").trim();
            const newDateRaw = interaction.fields.getTextInputValue("new_date").trim();

            if (!newReason) {
                await interaction.reply({ content: "⚠️ เหตุผลห้ามว่าง", ephemeral: true });
                return;
            }

            // Validate วันที่ใหม่
            if (!singleDateRegex.test(newDateRaw)) {
                await interaction.reply({
                    content: "⚠️ รูปแบบวันที่ไม่ถูกต้อง กรุณาใช้ `dd/mm/yy` เช่น `25/08/25`",
                    ephemeral: true,
                });
                return;
            }

            const parsedNewDate = parseDDMMYY(newDateRaw);
            if (isNaN(parsedNewDate)) {
                await interaction.reply({
                    content: "⚠️ วันที่ไม่ถูกต้อง กรุณาตรวจสอบ",
                    ephemeral: true,
                });
                return;
            }

            const newDate = fmtDDMMYY(parsedNewDate);
            const dateChanged = newDate !== oldDate;

            // หา entry เดิม
            let oldReason = "";
            let entryIndex = -1;
            if (leaveMessages[oldDate]) {
                entryIndex = leaveMessages[oldDate].findIndex((e) => e.name === name);
                if (entryIndex !== -1) {
                    oldReason = leaveMessages[oldDate][entryIndex].reason;
                }
            }

            if (entryIndex === -1) {
                await interaction.reply({
                    content: "⚠️ ไม่พบข้อมูลนี้แล้ว (อาจถูกลบไปแล้ว)",
                    ephemeral: true,
                });
                return;
            }

            if (dateChanged) {
                // ย้าย entry จากวันเดิมไปวันใหม่
                const [entry] = leaveMessages[oldDate].splice(entryIndex, 1);
                entry.reason = newReason;
                if (leaveMessages[oldDate].length === 0) delete leaveMessages[oldDate];

                if (!leaveMessages[newDate]) leaveMessages[newDate] = [];
                leaveMessages[newDate].push(entry);
            } else {
                // แก้เฉพาะเหตุผล
                leaveMessages[oldDate][entryIndex].reason = newReason;
            }

            await saveToDisk();

            const fields = [
                { name: "ชื่อ", value: name, inline: true },
            ];

            if (oldReason !== newReason) {
                fields.push({ name: "เหตุผลเดิม", value: oldReason, inline: true });
                fields.push({ name: "เหตุผลใหม่", value: newReason, inline: true });
            } else {
                fields.push({ name: "เหตุผล", value: newReason, inline: true });
            }

            if (dateChanged) {
                fields.push({ name: "วันที่เดิม", value: oldDate, inline: true });
                fields.push({ name: "วันที่ใหม่", value: newDate, inline: true });
            } else {
                fields.push({ name: "วันที่", value: newDate, inline: true });
            }

            const embed = new EmbedBuilder()
                .setTitle("✏️ แก้ไขข้อมูลการลาสำเร็จ")
                .addFields(fields)
                .setTimestamp(new Date())
                .setColor(0xf59e0b);

            // ลบปุ่มจากข้อความเดิมเพื่อกันกดซ้ำ
            try {
                await interaction.message?.edit({ components: [] });
            } catch (_) { }

            await interaction.reply({ embeds: [embed] });
            return;
        }
    } catch (err) {
        console.error("Interaction error:", err);
        const reply = { content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่", ephemeral: true };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply).catch(() => { });
        } else {
            await interaction.reply(reply).catch(() => { });
        }
    }
});

// ---------- Cleanup: ลบวันลาที่ตกค้าง (อดีต) ----------
async function cleanupExpiredLeaves() {
    const today = startOfDay(new Date());
    let cleaned = 0;

    for (const dateKey of Object.keys(leaveMessages)) {
        const d = parseDDMMYY(dateKey);
        if (!isNaN(d) && d < today) {
            cleaned += leaveMessages[dateKey].length;
            delete leaveMessages[dateKey];
        }
    }

    if (cleaned > 0) {
        await saveToDisk();
        console.log(`🧹 ลบข้อมูลลาที่ตกค้าง ${cleaned} รายการ`);
    }
}

// ---------- Daily Report ----------
// เก็บ snapshot ของรายงาน 9 โมงเช้าเพื่อเปรียบเทียบตอนบ่าย
let morningReportNames = new Set();

async function sendDailyReport() {
    try {
        // ลบวันลาที่ตกค้างก่อนรายงาน
        await cleanupExpiredLeaves();

        const channel = await client.channels.fetch(REPORT_CHANNEL);

        const now = new Date();
        const dd = String(now.getDate()).padStart(2, "0");
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const yy = String(now.getFullYear()).slice(-2);
        const todayKey = `${dd}/${mm}/${yy}`;

        const todayLeaves = leaveMessages[todayKey] || [];

        // บันทึกชื่อคนที่รายงานตอนเช้า
        morningReportNames = new Set(todayLeaves.map((e) => e.name));

        if (todayLeaves.length === 0) return;

        let report = `📋 รายงานการลา วันที่ ${todayKey}\n\n`;
        todayLeaves.forEach((msg, i) => {
            report += `${i + 1}. ${msg.name} (${msg.user}) - ${msg.reason}\n`;
        });

        await channel.send(report);
    } catch (err) {
        console.error("Error sending morning report:", err);
    }
}

async function sendAfternoonReport() {
    try {
        const channel = await client.channels.fetch(REPORT_CHANNEL);

        const now = new Date();
        const dd = String(now.getDate()).padStart(2, "0");
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const yy = String(now.getFullYear()).slice(-2);
        const todayKey = `${dd}/${mm}/${yy}`;

        const todayLeaves = leaveMessages[todayKey] || [];

        // กรองเฉพาะคนที่เพิ่มมาหลัง 9 โมง (ไม่เคยอยู่ในรายงานเช้า)
        const newEntries = todayLeaves.filter((e) => !morningReportNames.has(e.name));

        if (newEntries.length === 0) return;

        let report = `📋 รายงานการลาเพิ่มเติม (บ่าย) วันที่ ${todayKey}\n\n`;
        newEntries.forEach((msg, i) => {
            report += `${i + 1}. ${msg.name} (${msg.user}) - ${msg.reason}\n`;
        });

        await channel.send(report);

        // เคลียร์ของวันนั้นและบันทึก (ตอนบ่ายค่อยเคลียร์)
        delete leaveMessages[todayKey];
        morningReportNames = new Set();
        await saveToDisk();
    } catch (err) {
        console.error("Error sending afternoon report:", err);
    }
}

// ตั้งเวลา 9 โมงเช้าตาม TIMEZONE
cron.schedule("0 9 * * *", () => sendDailyReport(), { timezone: TZ });
// ตั้งเวลาบ่ายโมง (13:00) ตาม TIMEZONE
cron.schedule("0 13 * * *", () => sendAfternoonReport(), { timezone: TZ });

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    // เคลียร์วันลาที่ตกค้างตอนเริ่มบอท
    await cleanupExpiredLeaves();
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
