# Questions for Telnyx support: receive-only SMS for Easy Voice

Draft, 2026-10-16. Background: SPEC §17 and `docs/telnyx-api-notes.md` §14. Not sent yet.

---

**Subject:** Receiving SMS on US local numbers without 10DLC registration

Hi Telnyx team,

We run Easy Voice, a web app on a single Telnyx account. Each signed-up individual gets one US local number and a
Telnyx AI Assistant that answers and places calls for them. We'd like those numbers to **receive** SMS, which we'd
store and show in our app. We won't send any messages from these numbers, so we're not registering for 10DLC. A few
questions:

1. Can a US local number reliably receive SMS from all major carriers (T-Mobile, AT&T, Verizon) without being on a
   10DLC campaign? Are there any carrier-side limits on inbound to unregistered numbers?
2. Can one number be attached to our Call Control application (for voice) and assigned to a messaging profile (for
   inbound SMS) at the same time, without affecting voice?
3. When a sender texts STOP, HELP or another keyword, does Telnyx send an automatic reply from our number? If so:
   - Is that reply blocked or filtered because the number isn't registered?
   - Can we turn auto-replies off for a messaging profile, and should we?
4. What does an inbound SMS cost per message or segment on a US local number? Is there a monthly fee for messaging
   on the number or the messaging profile?
5. Does the `message.received` webhook always include `cost` and `parts` for inbound messages? Are there any other
   events we should expect for inbound-only use?
6. Does a messaging profile used only for inbound need any extra account verification or enablement?
7. For MMS sent to these numbers: do we receive the media URLs even though we never send MMS, and how long do they
   stay valid?

Thanks!
