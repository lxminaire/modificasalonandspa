require("dotenv").config();

const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;


/*
|--------------------------------------------------------------------------
| SERVICE PRICE LIST IMAGES
|--------------------------------------------------------------------------
*/

const SERVICE_IMAGES = {
    HAIR_MAKEUP: "https://user19535.na.imgto.link/public/20260731/price-hairmakeup.avif",
    FACIAL: "https://user19535.na.imgto.link/public/20260731/price-aesthetics.avif",
    MASSAGE: "https://user19535.na.imgto.link/public/20260731/price-massage.avif",
    MAKEUP: "https://user19535.na.imgto.link/public/20260731/price-eyelash.avif",
    NAILS: "https://user19535.na.imgto.link/public/20260731/price-nails.avif"
};


/*
|--------------------------------------------------------------------------
| PROMOTIONS IMAGES
|--------------------------------------------------------------------------
*/

const PROMO_IMAGES = [
    "https://user19535.na.imgto.link/public/20260731/deals1.avif",
    "https://user19535.na.imgto.link/public/20260731/deals2.avif",
    "https://user19535.na.imgto.link/public/20260731/deals3.avif",
    "https://user19535.na.imgto.link/public/20260731/deals4.avif"
];


/*
|--------------------------------------------------------------------------
| BOT TEXT CONTENT
|--------------------------------------------------------------------------
| All fixed strings the bot ever sends, defined once here and reused
| everywhere below. This is also what powers human-takeover detection
| (see KNOWN_BOT_TEXTS) — if an outgoing message's text doesn't match
| one of these, it wasn't sent by this bot.
*/

const TEXTS = {

    GREETING:
    "Hello! 👋 Welcome to Modifica Salon and Spa.\n\nHow can I assist you today?",

    SERVICES_PROMPT:
    "🏷️ Please Choose from our Pricelist Categories below:",

    SERVICES_PROMOS_PROMPT:
    "💅 Services & Promos\n\nWhat would you like to check out?",

    LOCATION:
    "This branch is located at 📍 C. Lawis Ext., Brgy. San Luis, Antipolo City (Near Genesis College & Cerlas Hardware). \n\n 📍We also have a branch in ML Quezon Ext., Brgy. Dalig, Antipolo City (In front of Vista Mall Antipolo).",

    UNRECOGNIZED:
    "I'm sorry, I didn't understand that. 😊\n\nYou can ask about:\n\n💅 Services\n📅 Appointments\n⭐ Rewards\n📍 Locations\n\n📞 For further assistance, you may contact us directly at +63 915 627 3312.",

    REWARDS:
    "⭐ Modifica Rewards is coming soon!\n\nYour loyalty points and exclusive rewards will be available here.",

    REWARDS_ASK_IDENTIFIER:
    "⭐ To check your Modifica Rewards points, please type either the email or contact number you used to sign up (e.g. juan@email.com or 09151234567). 📧📱\n\n(Type \"cancel\" to stop)",

    REWARDS_INVALID_IDENTIFIER:
    "That doesn't look like a valid email or contact number. 📧📱 Please try again, or type \"cancel\" to stop.",

    REWARDS_NOT_FOUND:
    "We couldn't find a rewards account linked to that. 😕\n\nMake sure you're using the email or number you signed up with, or contact us at +63 915 627 3312.",

    REWARDS_ERROR:
    "Sorry, we're having trouble checking your rewards right now. 😓\n\nPlease try again later or contact us at +63 915 627 3312.",

    REWARDS_CANCELLED:
    "No problem! Let me know if you'd like to check your rewards again anytime. ⭐",

    REWARDS_DISCONNECTED:
    "🔌 Your account has been disconnected. No worries — let's link it again below. ⭐",

    BOOKING_PROMPT:
    "Ready to book your appointment? 💇‍♀️\n\nContinue through our official booking page:",

    PROMO_CLOSING:
    "Want to book one of these promos? 💇‍♀️\n\nContinue through our official booking page:"

};

// The rewards points reply is dynamic ("You currently have 120 points...")
// so it can never live in TEXTS/KNOWN_BOT_TEXTS as a fixed string. This
// builds that message and recognizes it for echo/human-takeover detection.
function buildRewardsPointsMessage(points){
    return `⭐ You currently have ${points} loyalty point${points === 1 ? "" : "s"} at Modifica Salon and Spa!\n\nKeep booking to earn more and unlock rewards. 🎁`;
}

const REWARDS_POINTS_PATTERN = /^⭐ You currently have \d+ loyalty points? at Modifica Salon and Spa!\n\nKeep booking to earn more and unlock rewards\. 🎁$/;

const KNOWN_BOT_TEXTS = new Set(Object.values(TEXTS));

// Use this instead of KNOWN_BOT_TEXTS.has() directly wherever bot-authored
// text needs to be recognized — covers both fixed strings and the dynamic
// rewards points message.
function isKnownBotText(text){
    return KNOWN_BOT_TEXTS.has(text) || REWARDS_POINTS_PATTERN.test(text);
}


/*
|--------------------------------------------------------------------------
| HUMAN AGENT TAKEOVER / BOT HIBERNATION
|--------------------------------------------------------------------------
| If a human agent sends a message from the Page that isn't one of the
| bot's known texts, the bot goes silent for that specific customer for
| 30 minutes. Every new human message resets the 3-minute timer, so
| the bot stays asleep as long as the agent keeps replying.
|
| NOTE: In-memory only — resets on server restart. Also only detects
| takeover on messages that contain text; a human agent replying with
| only an image (no text) won't be detected as a takeover.
*/

const HUMAN_HIBERNATION_MS = 3 * 60 * 1000; // 3 minutes

const humanTakeoverState = new Map();
// customerId (PSID) -> lastHumanMessageAt timestamp

function registerHumanMessage(customerId){
    humanTakeoverState.set(customerId, Date.now());
    console.log("🧑‍💼 Human agent message detected for", customerId, "— bot hibernating for 3 minutes");
}

function isHibernating(customerId){
    const lastHuman = humanTakeoverState.get(customerId);
    if(!lastHuman) return false;
    return (Date.now() - lastHuman) < HUMAN_HIBERNATION_MS;
}


/*
|--------------------------------------------------------------------------
| FALLBACK MESSAGE RATE LIMITING
|--------------------------------------------------------------------------
| Tracks, per user, how many consecutive unrecognized messages they've
| sent, and when they last received the "I don't understand" fallback.
|
| Rules:
| - The fallback message (with contact number) only sends on every
|   3rd unrecognized message. The 1st and 2nd get no reply at all.
| - If 12+ hours have passed since the last fallback was sent to that
|   user, the 3-message requirement resets — the very next unrecognized
|   message triggers the fallback immediately.
|
| NOTE: In-memory only — resets on server restart.
*/

const FALLBACK_THRESHOLD = 3;
const FALLBACK_RESET_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

const userFallbackState = new Map();
// senderId -> { count: number, lastFallbackSentAt: number|null }

function shouldSendFallback(senderId){

    const state = userFallbackState.get(senderId) || { count: 0, lastFallbackSentAt: null };

    state.count += 1;

    const now = Date.now();

    const resetWindowPassed =
        state.lastFallbackSentAt !== null &&
        (now - state.lastFallbackSentAt) > FALLBACK_RESET_WINDOW_MS;

    let shouldSend = false;

    if(resetWindowPassed){
        shouldSend = true;
    }
    else if(state.count >= FALLBACK_THRESHOLD){
        shouldSend = true;
    }

    if(shouldSend){
        state.count = 0;
        state.lastFallbackSentAt = now;
    }

    userFallbackState.set(senderId, state);

    return shouldSend;
}


/*
|--------------------------------------------------------------------------
| REWARDS RECOGNITION (VERIFIED CUSTOMERS)
|--------------------------------------------------------------------------
| Once a customer's phone number is successfully matched to a Wix
| Loyalty account, we remember them permanently (until server restart)
| so every future "My Rewards" tap goes straight to their points —
| no need to re-type their number again.
|
| NOTE: In-memory only — resets on server restart. For real persistence
| across restarts/deploys, this Map would need to be backed by a file
| or database instead.
*/

const verifiedRewardsCustomers = new Map();
// senderId (PSID) -> { contactId, phone }

function getVerifiedRewardsCustomer(senderId){
    return verifiedRewardsCustomers.get(senderId) || null;
}

function setVerifiedRewardsCustomer(senderId, contactId, identifier){
    verifiedRewardsCustomers.set(senderId, { contactId, identifier });
}

function clearVerifiedRewardsCustomer(senderId){
    verifiedRewardsCustomers.delete(senderId);
}


/*
|--------------------------------------------------------------------------
| REWARDS IDENTIFIER COLLECTION STATE
|--------------------------------------------------------------------------
| When a customer taps "Rewards" for the first time, we ask for either
| the email or contact number they used to sign up so we can look up
| their Wix Loyalty account. This tracks who's currently expected to
| reply with an identifier next, so the following text message is
| treated as that identifier instead of running through the normal
| keyword engine.
|
| NOTE: In-memory only — resets on server restart.
*/

const REWARDS_IDENTIFIER_WAIT_MS = 10 * 60 * 1000; // 10 minutes

const awaitingRewardsIdentifier = new Map();
// senderId -> timestamp the prompt was sent

function setAwaitingRewardsIdentifier(senderId){
    awaitingRewardsIdentifier.set(senderId, Date.now());
}

function clearAwaitingRewardsIdentifier(senderId){
    awaitingRewardsIdentifier.delete(senderId);
}

function isAwaitingRewardsIdentifier(senderId){
    const askedAt = awaitingRewardsIdentifier.get(senderId);
    if(!askedAt) return false;

    if((Date.now() - askedAt) > REWARDS_IDENTIFIER_WAIT_MS){
        awaitingRewardsIdentifier.delete(senderId);
        return false;
    }

    return true;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Loose match for PH-style numbers: optional +, 7-15 digits, spaces/dashes allowed
const PHONE_PATTERN = /^[+]?[\d\s-]{7,15}$/;


/*
|--------------------------------------------------------------------------
| WIX CONTACTS + LOYALTY PROGRAM INTEGRATION
|--------------------------------------------------------------------------
| Looks up a customer's Wix Loyalty account by either email or phone:
|   - Email: uses the Loyalty "Search Accounts" API directly, which can
|     search by contact.email.
|   - Phone: Loyalty Search Accounts can't search by phone, so this is
|     a two-step lookup instead — find the Wix Contact whose
|     primaryInfo.phone matches (Contacts API), then fetch that
|     contact's Loyalty account by contact ID (Get Account By
|     Secondary ID).
|
| Requires WIX_API_KEY and WIX_SITE_ID in .env — see Wix's API Keys
| Manager (Account Settings) and the site dashboard URL (site ID
| appears after /dashboard/) to obtain these. The API key needs
| "Read Contacts (PII)" and "Read Loyalty" permissions.
*/

function wixHeaders(){
    return {
        "Content-Type":"application/json",
        "Authorization": process.env.WIX_API_KEY,
        "wix-site-id": process.env.WIX_SITE_ID
    };
}

// Returns { contactId, points } or null if no account is found.
async function getWixLoyaltyAccountByEmail(email){

    const response = await fetch(
        "https://www.wixapis.com/loyalty-accounts/v1/accounts/search",
        {
            method:"POST",
            headers: wixHeaders(),
            body:JSON.stringify({
                search:{
                    filter:{
                        "contact.email": { "$eq": email }
                    }
                }
            })
        }
    );

    const data = await response.json();

    console.log("🏆 Wix Loyalty API (search by email):");
    console.log(JSON.stringify(data));

    if(!response.ok){
        throw new Error(`Wix Loyalty API error: ${response.status} ${JSON.stringify(data)}`);
    }

    const account = data.accounts && data.accounts[0];

    if(!account) return null;

    return {
        contactId: account.contactId,
        points: account.points && typeof account.points.balance === "number"
            ? account.points.balance
            : 0
    };
}

async function getWixContactIdByPhone(phone){

    const response = await fetch(
        "https://www.wixapis.com/contacts/v4/contacts/query",
        {
            method:"POST",
            headers: wixHeaders(),
            body:JSON.stringify({
                query:{
                    filter:{
                        "primaryInfo.phone": { "$eq": phone }
                    }
                }
            })
        }
    );

    const data = await response.json();

    console.log("👤 Wix Contacts API:");
    console.log(JSON.stringify(data));

    if(!response.ok){
        throw new Error(`Wix Contacts API error: ${response.status} ${JSON.stringify(data)}`);
    }

    const contact = data.contacts && data.contacts[0];

    return contact ? contact.id : null;
}

async function getWixLoyaltyPointsByContactId(contactId){

    const response = await fetch(
        `https://www.wixapis.com/loyalty-accounts/v1/accounts/fetch-by?contactId=${encodeURIComponent(contactId)}`,
        {
            method:"GET",
            headers: wixHeaders()
        }
    );

    const data = await response.json();

    console.log("🏆 Wix Loyalty API (fetch by contact ID):");
    console.log(JSON.stringify(data));

    if(!response.ok){
        // A 404 here just means this contact has no loyalty account yet
        if(response.status === 404) return null;
        throw new Error(`Wix Loyalty API error: ${response.status} ${JSON.stringify(data)}`);
    }

    const account = data.account;

    if(!account) return null;

    return account.points && typeof account.points.balance === "number"
        ? account.points.balance
        : 0;
}

// Given whatever the customer typed, looks up their Wix Loyalty account
// via email or phone as appropriate. Returns { contactId, points } or
// null if nothing matched.
async function lookupWixLoyaltyAccount(identifier){
    if(EMAIL_PATTERN.test(identifier)){
        return getWixLoyaltyAccountByEmail(identifier);
    }

    const contactId = await getWixContactIdByPhone(identifier);
    if(!contactId) return null;

    const points = await getWixLoyaltyPointsByContactId(contactId);
    if(points === null) return null;

    return { contactId, points };
}

// Sends the rewards points message with a "Disconnect" quick reply
// attached, so a customer who linked the wrong email/number can undo it
// and re-enter their identifier.
async function sendRewardsPointsMessage(senderId, points){
    return callMessengerAPI({
        recipient:{ id:senderId },
        message:{
            text: buildRewardsPointsMessage(points),
            quick_replies:[
                {
                    content_type:"text",
                    title:"🔌 Disconnect",
                    payload:"DISCONNECT_REWARDS"
                }
            ]
        }
    });
}

// Kicks off the rewards flow: if this Messenger user is already a
// verified customer, show their points immediately. Otherwise asks
// for their email or phone number. Falls back to the static "coming
// soon" message if Wix credentials aren't set up yet.
async function startRewardsFlow(senderId){
    if(!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID){
        console.log("⚠️ WIX_API_KEY / WIX_SITE_ID not set — falling back to static rewards message");
        await sendText(senderId, TEXTS.REWARDS);
        return;
    }

    const verified = getVerifiedRewardsCustomer(senderId);

    if(verified){
        try{
            const points = await getWixLoyaltyPointsByContactId(verified.contactId);

            if(points === null){
                await sendText(senderId, TEXTS.REWARDS_NOT_FOUND);
            }
            else{
                await sendRewardsPointsMessage(senderId, points);
            }
        }
        catch(error){
            console.error("❌ Wix Loyalty Error:", error);
            await sendText(senderId, TEXTS.REWARDS_ERROR);
        }
        return;
    }

    setAwaitingRewardsIdentifier(senderId);
    await sendText(senderId, TEXTS.REWARDS_ASK_IDENTIFIER);
}

// Handles the customer's reply once we're waiting on their email/phone.
async function handleRewardsIdentifierReply(senderId, messageText){

    const trimmed = messageText.trim();

    if(trimmed.toLowerCase() === "cancel"){
        clearAwaitingRewardsIdentifier(senderId);
        await sendText(senderId, TEXTS.REWARDS_CANCELLED);
        return;
    }

    const isEmail = EMAIL_PATTERN.test(trimmed);
    const isPhone = PHONE_PATTERN.test(trimmed);

    if(!isEmail && !isPhone){
        await sendText(senderId, TEXTS.REWARDS_INVALID_IDENTIFIER);
        return; // stay in the awaiting-identifier state, let them try again
    }

    clearAwaitingRewardsIdentifier(senderId);

    try{
        const result = await lookupWixLoyaltyAccount(trimmed);

        if(!result){
            await sendText(senderId, TEXTS.REWARDS_NOT_FOUND);
            return;
        }

        // Remember this customer permanently so future "My Rewards"
        // taps skip straight to their balance.
        setVerifiedRewardsCustomer(senderId, result.contactId, trimmed);

        await sendRewardsPointsMessage(senderId, result.points);
    }
    catch(error){
        console.error("❌ Wix Rewards Lookup Error:", error);
        await sendText(senderId, TEXTS.REWARDS_ERROR);
    }
}

// Handles the "Disconnect" quick reply on the rewards points message:
// forgets the verified customer and immediately re-prompts for their
// email/phone number so they can re-link with the correct one.
async function disconnectRewardsCustomer(senderId){
    clearVerifiedRewardsCustomer(senderId);
    clearAwaitingRewardsIdentifier(senderId); // just in case, reset any stale wait state

    await sendText(senderId, TEXTS.REWARDS_DISCONNECTED);
    await startRewardsFlow(senderId); // no longer verified, so this asks for the identifier again
}


/*
|--------------------------------------------------------------------------
| CONVERSATION ENGINE
|--------------------------------------------------------------------------
*/

function handleMessage(messageText){

    const text = messageText.toLowerCase();

    // Greeting
    if(
        text.includes("hello") ||
        text.includes("hi") ||
        text.includes("hey") ||
        text.includes("get started")
    ){
        return {
            type:"menu",
            text: TEXTS.GREETING,
            replies:[
                { title:"💅 Services & Promos", payload:"SERVICES" },
                { title:"📅 Book Appointment", payload:"BOOK_APPOINTMENT" },
                { title:"⭐ Rewards", payload:"REWARDS" },
                { title:"📍 Locations", payload:"LOCATIONS" }
            ]
        };
    }

    // Booking Keywords
    if(
        text.includes("book") ||
        text.includes("appointment") ||
        text.includes("schedule") ||
        text.includes("reserve")
    ){
        return { type:"booking" };
    }

    // Price Keywords
    if(
        text.includes("price") ||
        text.includes("cost") ||
        text.includes("rate") ||
        text.includes("magkano") ||
        text.includes("how much") ||
        /\bhm\b/.test(text)
    ){
        return { type:"services" };
    }

    // Promotions Keywords
    if(
        text.includes("promo") ||
        text.includes("promotion") ||
        text.includes("promotions") ||
        text.includes("deals") ||
        text.includes("discount") ||
        text.includes("sale")
    ){
        return { type:"promotions" };
    }

    // Location Keywords
    if(
        text.includes("location") ||
        text.includes("address") ||
        text.includes("branch") ||
        /\bloc\b/.test(text)
    ){
        return {
            type:"text",
            text: TEXTS.LOCATION
        };
    }

    // Default (unrecognized) — rate-limited fallback, handled by caller
    return {
        type:"unrecognized",
        text: TEXTS.UNRECOGNIZED
    };
}


/*
|--------------------------------------------------------------------------
| MESSENGER API CORE
|--------------------------------------------------------------------------
*/

async function callMessengerAPI(body){
    try{
        const response = await fetch(
            `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
            {
                method:"POST",
                headers:{ "Content-Type":"application/json" },
                body:JSON.stringify(body)
            }
        );

        const data = await response.json();

        console.log("📤 Messenger API:");
        console.log(data);

        return data;
    }
    catch(error){
        console.error("❌ Messenger Error:", error);
    }
}


/*
|--------------------------------------------------------------------------
| SEND TEXT MESSAGE
|--------------------------------------------------------------------------
*/

async function sendText(senderId, text){
    return callMessengerAPI({
        recipient:{ id:senderId },
        message:{ text:text }
    });
}


/*
|--------------------------------------------------------------------------
| SEND QUICK REPLIES
|--------------------------------------------------------------------------
*/

async function sendQuickReplies(senderId, text, replies){
    return callMessengerAPI({
        recipient:{ id:senderId },
        message:{
            text:text,
            quick_replies: replies.map(reply => ({
                content_type:"text",
                title:reply.title,
                payload:reply.payload
            }))
        }
    });
}


/*
|--------------------------------------------------------------------------
| SEND SERVICE IMAGE
|--------------------------------------------------------------------------
| category must be one of the KEYS in SERVICE_IMAGES (e.g. "HAIR_MAKEUP"),
| not the URL itself. Sends the pricelist image, then immediately follows
| up with the booking button message. The "Check our Promotions" quick
| reply is attached to that final booking message (NOT the image) since
| Messenger clears quick replies as soon as a newer message is sent —
| attaching it to the last message in the sequence keeps it visible.
*/

async function sendServiceImage(senderId, category){

    await callMessengerAPI({
        recipient:{ id:senderId },
        message:{
            attachment:{
                type:"image",
                payload:{
                    url:SERVICE_IMAGES[category],
                    is_reusable:true
                }
            }
        }
    });

    return sendBookingButton(senderId, [
        {
            content_type:"text",
            title:"🏷️ Check our Promotions",
            payload:"PROMOTIONS"
        }
    ]);
}


/*
|--------------------------------------------------------------------------
| SEND SERVICES & PROMOS MENU
|--------------------------------------------------------------------------
| Intermediate choice menu shown when "Services & Promos" is tapped
| (from the persistent menu or the greeting quick replies). Lets the
| customer pick between the pricelist categories or the promotions,
| each routing to their own existing flow.
*/

async function sendServicesPromosMenu(senderId){
    return sendQuickReplies(
        senderId,
        TEXTS.SERVICES_PROMOS_PROMPT,
        [
            { title:"🏷️ Our Pricelist", payload:"OUR_PRICELIST" },
            { title:"🎉 Current Promotions", payload:"PROMOTIONS" }
        ]
    );
}


/*
|--------------------------------------------------------------------------
| SEND SERVICE CATEGORY MENU
|--------------------------------------------------------------------------
*/

async function sendServiceCategories(senderId){
    return sendQuickReplies(
        senderId,
        TEXTS.SERVICES_PROMPT,
        [
            { title:"💇 Hair & Makeup", payload:"HAIR_MAKEUP" },
            { title:"✨ Facial & Slimming", payload:"FACIAL" },
            { title:"💆 Massage & Waxing", payload:"MASSAGE" },
            { title:"👁️ Semi-Permanent Makeup & Eyelashes", payload:"MAKEUP" },
            { title:"💅 Nails & Relaxing Packages", payload:"NAILS" }
        ]
    );
}


/*
|--------------------------------------------------------------------------
| SEND PROMOTIONS
|--------------------------------------------------------------------------
| Sends every promo image one after another, then a SINGLE closing
| message that combines the text + booking button together.
*/

async function sendPromotions(senderId){
    for(const url of PROMO_IMAGES){
        await callMessengerAPI({
            recipient:{ id:senderId },
            message:{
                attachment:{
                    type:"image",
                    payload:{
                        url:url,
                        is_reusable:true
                    }
                }
            }
        });
    }

    // Single closing message: text + booking button together
    await callMessengerAPI({
        recipient:{ id:senderId },
        message:{
            attachment:{
                type:"template",
                payload:{
                    template_type:"button",
                    text: TEXTS.PROMO_CLOSING,
                    buttons:[
                        {
                            type:"web_url",
                            url:"https://www.modificasalonandspa.com/booknow",
                            title:"📅 Book Appointment"
                        }
                    ]
                }
            }
        }
    });
}


/*
|--------------------------------------------------------------------------
| BOOKING BUTTON
|--------------------------------------------------------------------------
| quickReplies (optional) lets a caller attach quick replies to this
| message. Used by sendServiceImage() so the "Check our Promotions"
| quick reply survives as the final message in that flow, instead of
| being wiped out by a message sent right after it.
*/

async function sendBookingButton(senderId, quickReplies){

    const message = {
        attachment:{
            type:"template",
            payload:{
                template_type:"button",
                text: TEXTS.BOOKING_PROMPT,
                buttons:[
                    {
                        type:"web_url",
                        url:"https://www.modificasalonandspa.com/booknow",
                        title:"📅 Book Appointment"
                    }
                ]
            }
        }
    };

    if(quickReplies){
        message.quick_replies = quickReplies;
    }

    return callMessengerAPI({
        recipient:{ id:senderId },
        message
    });
}


/*
|--------------------------------------------------------------------------
| MESSENGER PROFILE (GREETING + GET STARTED + PERSISTENT MENU)
|--------------------------------------------------------------------------
| Configures the pre-chat greeting screen, the "Get Started" button new
| customers see on their very first visit (tapping it fires a postback
| with payload GET_STARTED — handled in handlePayload), and the
| persistent menu.
*/

async function setMessengerProfile(){
    try{
        const response = await fetch(
            `https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${process.env.PAGE_ACCESS_TOKEN}`,
            {
                method:"POST",
                headers:{ "Content-Type":"application/json" },
                body:JSON.stringify({
                    greeting:[
                        {
                            locale:"default",
                            text:"Welcome to Modifica Salon and Spa! 💇‍♀️ Tap Get Started to see our services, book an appointment, and more."
                        }
                    ],
                    get_started:{
                        payload:"GET_STARTED"
                    },
                    persistent_menu:[
                        {
                            locale:"default",
                            composer_input_disabled:false,
                            call_to_actions:[
                                { type:"postback", title:"💅 Services & Promos", payload:"SERVICES" },
                                { type:"web_url", title:"📅 Book Appointment", url:"https://www.modificasalonandspa.com/booknow" },
                                { type:"postback", title:"⭐ My Rewards", payload:"REWARDS" },
                                { type:"postback", title:"📍 Locations", payload:"LOCATIONS" }
                            ]
                        }
                    ]
                })
            }
        );

        const data = await response.json();

        console.log("📌 Messenger Profile Updated:");
        console.log(data);
    }
    catch(error){
        console.error("❌ Messenger Profile Error:", error);
    }
}


/*
|--------------------------------------------------------------------------
| HOME ROUTE
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.send("🎉 Modifica Smart Assistant is running!");
});


/*
|--------------------------------------------------------------------------
| PRIVACY POLICY
|--------------------------------------------------------------------------
*/

app.get("/privacy-policy", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Privacy Policy — Modifica Salon and Spa Messenger Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222;">
            <h1>Privacy Policy</h1>
            <p><em>Last updated: August 2026</em></p>

            <p>This Privacy Policy explains how Modifica Salon and Spa ("we", "us", "our") collects, uses, and protects information when you interact with our Messenger bot ("the Bot") on Facebook Messenger.</p>

            <h2>Information We Collect</h2>
            <ul>
                <li>Your Facebook Page-Scoped ID (PSID), a unique identifier used to send you messages through Messenger.</li>
                <li>The content of messages you send to the Bot, including selections from menus and quick replies.</li>
                <li>If you use the Rewards feature, the email address or phone number you provide to look up your loyalty account.</li>
            </ul>

            <h2>How We Use Your Information</h2>
            <ul>
                <li>To respond to your messages and provide information about our services, promotions, and locations.</li>
                <li>To look up your loyalty rewards account and display your points balance, using our Wix Loyalty and Contacts records.</li>
                <li>To allow our staff to take over a conversation from the Bot when needed to assist you directly.</li>
            </ul>

            <h2>Data Sharing</h2>
            <p>We do not sell or share your information with third parties for marketing purposes. Information you provide is shared only with:</p>
            <ul>
                <li>Meta (Facebook), as the platform through which Messenger operates.</li>
                <li>Wix, our website and business management platform, to verify and retrieve your loyalty rewards account.</li>
            </ul>

            <h2>Data Retention</h2>
            <p>Certain identifiers (such as your PSID and linked rewards account) are retained to provide a continuous experience, such as remembering your rewards account for future visits. You may disconnect your linked rewards account at any time using the "Disconnect" option in the Bot.</p>

            <h2>Your Choices</h2>
            <p>You may stop interacting with the Bot at any time by blocking or unsubscribing from our Facebook Page. You can request removal of your data by contacting us using the details below.</p>

            <h2>Contact Us</h2>
            <p>If you have questions about this Privacy Policy or your data, please contact us at:</p>
            <p>📞 +63 915 627 3312<br>
            🌐 <a href="https://www.modificasalonandspa.com">modificasalonandspa.com</a></p>
        </body>
        </html>
    `);
});


/*
|--------------------------------------------------------------------------
| WEBHOOK VERIFICATION
|--------------------------------------------------------------------------
*/

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if(
        mode === "subscribe" &&
        token === process.env.VERIFY_TOKEN
    ){
        console.log("✅ Webhook Verified!");
        return res.status(200).send(challenge);
    }

    console.log("❌ Verification Failed");
    res.sendStatus(403);
});


/*
|--------------------------------------------------------------------------
| WEBHOOK RECEIVER
|--------------------------------------------------------------------------
| Acknowledge Facebook immediately with 200, then process events
| asynchronously. This avoids Facebook timing out and re-sending
| the same event as a retry.
|
| Echo events (event.message.is_echo === true) represent messages sent
| FROM the Page. If the echoed text matches one of the bot's own known
| strings, it was the bot's own send — ignored as before. If it doesn't
| match, it's a human agent typing directly, which triggers hibernation
| for that specific customer (event.recipient.id, since in an echo the
| customer is the recipient, not the sender).
*/

app.post("/webhook", (req, res) => {

    res.sendStatus(200); // ack immediately, before any async work

    (async () => {

        const body = req.body;

        if(body.object !== "page") return;

        for(const entry of body.entry){

            if(!entry.messaging) continue;

            for(const event of entry.messaging){

                console.log("📨 EVENT RECEIVED");

                // ECHO HANDLER — detect human agent takeover
                if(event.message && event.message.is_echo){

                    const customerId = event.recipient.id;

                    const echoedText =
                        event.message.text ||
                        (event.message.attachment &&
                         event.message.attachment.payload &&
                         event.message.attachment.payload.text);

                    console.log("🔍 ECHO DEBUG:", {
                        customerId,
                        echoedText,
                        matchesKnownBotText: echoedText ? isKnownBotText(echoedText) : null,
                        timestamp: new Date().toISOString()
                    });

                    if(echoedText && !isKnownBotText(echoedText)){
                        registerHumanMessage(customerId);
                    }

                    continue;
                }

                const senderId = event.sender.id;

                // If a human agent is currently handling this customer, stay silent
                if(isHibernating(senderId)){
                    console.log("😴 Bot hibernating for", senderId, "— skipping auto-reply");
                    continue;
                }

                // QUICK REPLY HANDLER
                if(event.message && event.message.quick_reply){
                    const payload = event.message.quick_reply.payload;

                    console.log("🔘 QUICK REPLY:", payload);

                    await handlePayload(senderId, payload);
                    continue;
                }

                // NORMAL TEXT MESSAGE
                if(event.message && event.message.text){
                    const messageText = event.message.text;

                    console.log("📩 USER:", messageText);

                    // If we just asked this customer for their rewards
                    // email/phone, treat this reply as that identifier
                    // instead of running it through the normal keyword engine.
                    if(isAwaitingRewardsIdentifier(senderId)){
                        await handleRewardsIdentifierReply(senderId, messageText);
                        continue;
                    }

                    const reply = handleMessage(messageText);

                    if(reply.type === "menu"){
                        await sendQuickReplies(senderId, reply.text, reply.replies);
                    }
                    else if(reply.type === "booking"){
                        await sendBookingButton(senderId);
                    }
                    else if(reply.type === "services"){
                        await sendServiceCategories(senderId);
                    }
                    else if(reply.type === "promotions"){
                        await sendPromotions(senderId);
                    }
                    else if(reply.type === "text"){
                        await sendText(senderId, reply.text);
                    }
                    else if(reply.type === "unrecognized"){
                        if(shouldSendFallback(senderId)){
                            await sendText(senderId, reply.text);
                        }
                        // else: stay silent, this wasn't the 3rd unrecognized message yet
                    }
                }

                // POSTBACK HANDLER
                if(event.postback){
                    const payload = event.postback.payload;

                    console.log("📌 POSTBACK:", payload);

                    await handlePayload(senderId, payload);
                }
            }
        }

    })().catch(err => console.error("❌ Webhook processing error:", err));

});


/*
|--------------------------------------------------------------------------
| PAYLOAD HANDLER
|--------------------------------------------------------------------------
*/

async function handlePayload(senderId, payload){

    console.log("📌 Handling Payload:", payload);

    if(payload === "GET_STARTED"){
        await sendQuickReplies(senderId, TEXTS.GREETING, [
            { title:"💅 Services & Promos", payload:"SERVICES" },
            { title:"📅 Book Appointment", payload:"BOOK_APPOINTMENT" },
            { title:"⭐ Rewards", payload:"REWARDS" },
            { title:"📍 Locations", payload:"LOCATIONS" }
        ]);
        return;
    }

    if(payload === "SERVICES"){
        await sendServicesPromosMenu(senderId);
        return;
    }

    if(payload === "OUR_PRICELIST"){
        await sendServiceCategories(senderId);
        return;
    }

    if(payload === "HAIR_MAKEUP"){
        await sendServiceImage(senderId, "HAIR_MAKEUP");
        return;
    }

    if(payload === "FACIAL"){
        await sendServiceImage(senderId, "FACIAL");
        return;
    }

    if(payload === "MASSAGE"){
        await sendServiceImage(senderId, "MASSAGE");
        return;
    }

    if(payload === "MAKEUP"){
        await sendServiceImage(senderId, "MAKEUP");
        return;
    }

    if(payload === "NAILS"){
        await sendServiceImage(senderId, "NAILS");
        return;
    }

    if(payload === "PROMOTIONS"){
        await sendPromotions(senderId);
        return;
    }

    if(payload === "BOOK_APPOINTMENT"){
        await sendBookingButton(senderId);
        return;
    }

    if(payload === "REWARDS"){
        await startRewardsFlow(senderId);
        return;
    }

    if(payload === "DISCONNECT_REWARDS"){
        await disconnectRewardsCustomer(senderId);
        return;
    }

    if(payload === "LOCATIONS"){
        await sendText(senderId, TEXTS.LOCATION);
        return;
    }
}


app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await setMessengerProfile();
});