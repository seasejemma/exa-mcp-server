import { z } from "zod";
import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_CONFIG } from "./config.js";
import { ExaSearchRequest, ExaSearchResponse } from "../types.js";
import { createRequestLogger } from "../utils/logger.js";
import { makeExaRequest } from "../utils/exaClient.js";

export function registerCompanyResearchTool(server: McpServer, config?: { exaApiKey?: string }): void {
  server.tool(
    "company_research_exa",
    "Research companies using Exa AI - finds comprehensive information about businesses, organizations, and corporations. Provides insights into company operations, news, financial information, and industry analysis.",
    {
      companyName: z.string().describe("Name of the company to research"),
      numResults: z.number().optional().describe("Number of search results to return (default: 5)")
    },
    async ({ companyName, numResults }) => {
      const requestId = `company_research_exa-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const logger = createRequestLogger(requestId, 'company_research_exa');
      
      logger.start(companyName);
      
      try {
        const searchRequest: ExaSearchRequest = {
          query: `${companyName} company business corporation information news financial`,
          type: "auto",
          numResults: numResults || API_CONFIG.DEFAULT_NUM_RESULTS,
          contents: {
            text: {
              maxCharacters: API_CONFIG.DEFAULT_MAX_CHARACTERS
            },
            livecrawl: 'preferred'
          },
          includeDomains: ["bloomberg.com", "reuters.com", "crunchbase.com", "sec.gov", "linkedin.com", "forbes.com", "businesswire.com", "prnewswire.com"]
        };
        
        logger.log("Sending request to Exa API for company research");
        
        // Use makeExaRequest for automatic key rotation on balance errors
        const responseData = await makeExaRequest<ExaSearchResponse>(
          API_CONFIG.ENDPOINTS.SEARCH,
          searchRequest,
          { exaApiKey: config?.exaApiKey, timeout: 25000 }
        );
        
        logger.log("Received response from Exa API");

        if (!responseData || !responseData.results) {
          logger.log("Warning: Empty or invalid response from Exa API");
          return {
            content: [{
              type: "text" as const,
              text: "No company information found. Please try a different company name."
            }]
          };
        }

        logger.log(`Found ${responseData.results.length} company research results`);
        
        const result = {
          content: [{
            type: "text" as const,
            text: JSON.stringify(responseData, null, 2)
          }]
        };
        
        logger.complete();
        return result;
      } catch (error) {
        logger.error(error);
        
        if (axios.isAxiosError(error)) {
          // Handle Axios errors specifically
          const statusCode = error.response?.status || 'unknown';
          const errorMessage = error.response?.data?.message || error.message;
          
          logger.log(`Axios error (${statusCode}): ${errorMessage}`);
          return {
            content: [{
              type: "text" as const,
              text: `Company research error (${statusCode}): ${errorMessage}`
            }],
            isError: true,
          };
        }
        
        // Handle generic errors
        return {
          content: [{
            type: "text" as const,
            text: `Company research error: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true,
        };
      }
    }
  );
} 