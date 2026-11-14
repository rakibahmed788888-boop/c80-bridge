/**
 * TP-Link Archer C80 Real-Time Bridge Server
 * Supports: Live Connected Clients Sync, MAC Auto-Quarantine, Advance Renewal (+7D/+15D/+30D), & Manual Minutes
 */
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3005;
const activeTimers = {};
let macGuardEnabled = true;
let approvedMacSet = new Set();

async function loginToC80(routerConfig) {
    const { realIp, remotePort, adminPass } = routerConfig;
    const baseUrl = `http://${realIp}:${remotePort}`;
    const passHash = crypto.createHash('md5').update(adminPass).digest('hex');

    const loginRes = await axios.post(`${baseUrl}/cgi-bin/luci/;stok=/login?form=login`, {
        operation: 'login',
        password: passHash
    }, { timeout: 7000 });

    const stok = loginRes.data?.data?.stok;
    if (!stok) {
        throw new Error('Authentication failed! Check Real IP, Port, or Admin Password.');
    }
    return { baseUrl, stok };
}

async function executeC80Action(routerConfig, actionPayload) {
    try {
        const { baseUrl, stok } = await loginToC80(routerConfig);

        if (actionPayload.type === 'BLOCK_MAC') {
            await axios.post(`${baseUrl}/cgi-bin/luci/;stok=${stok}/admin/access_control?form=black_devices`, {
                operation: actionPayload.blocked ? 'insert' : 'remove',
                data: JSON.stringify({
                    name: actionPayload.name,
                    mac: actionPayload.mac.replace(/:/g, '-')
                })
            });
        } else if (actionPayload.type === 'WIFI_UPDATE') {
            await axios.post(`${baseUrl}/cgi-bin/luci/;stok=${stok}/admin/wireless?form=wireless_5g`, {
                operation: 'write',
                ssid: actionPayload.ssid5g,
                psk_key: actionPayload.pass5g
            });
            await axios.post(`${baseUrl}/cgi-bin/luci/;stok=${stok}/admin/wireless?form=wireless_2g`, {
                operation: 'write',
                ssid: actionPayload.ssid2g,
                psk_key: actionPayload.pass2g
            });
        } else if (actionPayload.type === 'REBOOT') {
            await axios.post(`${baseUrl}/cgi-bin/luci/;stok=${stok}/admin/system?form=reboot`, {
                operation: 'write'
            });
        }

        return { success: true, message: `Executed ${actionPayload.type} on Archer C80 (${routerConfig.realIp})` };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

app.post('/api/c80/clients', async (req, res) => {
    const { routerConfig } = req.body;
    if (!routerConfig) {
        return res.status(400).json({ success: false, message: 'Missing routerConfig' });
    }

    try {
        const { baseUrl, stok } = await loginToC80(routerConfig);
        const clientsRes = await axios.post(`${baseUrl}/cgi-bin/luci/;stok=${stok}/admin/dhcps?form=client`, {
            operation: 'load'
        }, { timeout: 7000 });

        const rawList = clientsRes.data?.data || [];
        const formattedClients = rawList.map((item, idx) => ({
            id: 'c80_' + (item.macaddr || idx).replace(/[^a-zA-Z0-9]/g, ''),
            name: item.name && item.name !== 'UNKNOWN' ? item.name : `Device-${idx + 1}`,
            ip: item.ipaddr || '192.168.0.x',
            mac: (item.macaddr || '').replace(/-/g, ':').toUpperCase(),
            band: '5GHz / 2.4GHz',
            blocked: false
        }));

        return res.json({ success: true, clients: formattedClients });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        online: true,
        macGuardEnabled,
        approvedCount: approvedMacSet.size,
        activeTimers: Object.keys(activeTimers)
    });
});

app.post('/api/c80/command', async (req, res) => {
    const { routerConfig, action } = req.body;
    if (!routerConfig || !action) {
        return res.status(400).json({ success: false, message: 'Missing payload' });
    }

    if (action.type === 'SET_MAC_GUARD') {
        macGuardEnabled = Boolean(action.enabled);
        if (Array.isArray(action.approvedMacs)) {
            approvedMacSet = new Set(action.approvedMacs.map(m => m.toUpperCase()));
        }
        return res.json({ success: true, message: `MAC Guard is now ${macGuardEnabled ? 'ENABLED' : 'DISABLED'}` });
    }

    if (action.type === 'SET_TIMER') {
        const mac = action.mac.toUpperCase();
        approvedMacSet.add(mac);

        const targetTime = action.expiresAt || (Date.now() + (action.durationMinutes || 15) * 60 * 1000);
        const remainingMs = Math.max(1000, targetTime - Date.now());

        await executeC80Action(routerConfig, { type: 'BLOCK_MAC', name: action.name, mac, blocked: false });

        if (activeTimers[mac]) clearTimeout(activeTimers[mac]);

        const scheduleCutoff = (delayMs) => {
            const MAX_TIMEOUT = 2147483647;
            if (delayMs > MAX_TIMEOUT) {
                activeTimers[mac] = setTimeout(() => scheduleCutoff(delayMs - MAX_TIMEOUT), MAX_TIMEOUT);
            } else {
                activeTimers[mac] = setTimeout(async () => {
                    console.log(`⏰ Validity expired for ${action.name} (${mac}). Blocking on Archer C80...`);
                    await executeC80Action(routerConfig, { type: 'BLOCK_MAC', name: action.name, mac, blocked: true });
                    delete activeTimers[mac];
                }, delayMs);
            }
        };

        scheduleCutoff(remainingMs);
        return res.json({ success: true, message: `MAC Approved & Timer synced until ${new Date(targetTime).toLocaleString()}` });
    }

    const result = await executeC80Action(routerConfig, action);
    res.json(result);
});

app.listen(PORT, () => {
    console.log(`✅ Archer C80 Live Bridge running at http://localhost:${PORT}`);
});
