export type Json = string | number | boolean | null | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };
