import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.43.4/+esm";

export const SUPABASE_URL = "https://frdqkeaofjxmvvtfwgkf.supabase.co"; // REPLACE
export const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyZHFrZWFvZmp4bXZ2dGZ3Z2tmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDc5NDYxOTIsImV4cCI6MjA2MzUyMjE5Mn0.sEhuHmksq1VoOOjwY1DNazddQ0S8fXuxwfjjapIm8Zs"; // REPLACE
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);