export const SUPABASE_URL = "https://frdqkeaofjxmvvtfwgkf.supabase.co"; // REPLACE
export const SUPABASE_KEY = "sb_secret_x5shFFDtNc_Fpiu3MCnVVg_GMW2BgMh"; // REPLACE

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);