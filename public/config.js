// =====================================================================
// SETTINGS shared by the website (index.html) and the admin page (admin.html)
// =====================================================================
export const CONFIG = {
  // From Supabase → Project Settings → API (or "Connect" button):
  //   Project URL                      → supabaseUrl
  //   anon / publishable key           → supabaseKey
  // The anon/publishable key is MEANT to be public. It is safe here.
  // NEVER paste the "service_role" or "secret" key into this file.
  supabaseUrl: "https://xczqgsxqonwbridhkmgh.supabase.co",
  supabaseKey: "sb_publishable_uu9_fHT_ogbuvDgZLhFm9g_V-X10Wdw",

  // Card payments switch on once Paymob is connected (next step).
  cardPayments: false,

  // Opening hours, in Cairo time
  timeZone: "Africa/Cairo",
  openHour: 16,   // 4 pm
  closeHour: 1,   // 1 am (after midnight)
  phoneDisplay: "", // optional: shown in the footer for questions
};
