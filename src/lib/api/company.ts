import type {
  Company,
  CompanyEconomy,
  CreateCompanyRequest,
  LedgerEntry,
} from "@/lib/types";
import { api } from "./client";

export const companyApi = {
  getMyCompanies: () => api.get<Company[]>("/company/me/companies"),
  getCompany: () => api.get<Company>("/company"),
  getEconomy: () => api.get<CompanyEconomy>("/company/economy"),
  getLedger: () => api.get<LedgerEntry[]>("/company/ledger"),
  createCompany: (data: CreateCompanyRequest) =>
    api.post<Company>("/company", data),
};
