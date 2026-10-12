'use strict';

// Amazon region table for alexa-remote2 / alexa-cookie2.
// amazonPage: the Amazon site the account belongs to.
// baseAmazonPage: login domain used by the proxy. The alexa-cookie2 example
//   says all western countries (including Australia) use amazon.com here,
//   and Japan uses amazon.co.jp.
// acceptLanguage / proxyLanguage: language of the login pages.

const REGIONS = [
  { label: 'United States (amazon.com)', amazonPage: 'amazon.com', baseAmazonPage: 'amazon.com', acceptLanguage: 'en-US', proxyLanguage: 'en_US' },
  { label: 'United Kingdom (amazon.co.uk)', amazonPage: 'amazon.co.uk', baseAmazonPage: 'amazon.com', acceptLanguage: 'en-GB', proxyLanguage: 'en_GB' },
  { label: 'Canada (amazon.ca)', amazonPage: 'amazon.ca', baseAmazonPage: 'amazon.com', acceptLanguage: 'en-CA', proxyLanguage: 'en_CA' },
  { label: 'Australia (amazon.com.au)', amazonPage: 'amazon.com.au', baseAmazonPage: 'amazon.com', acceptLanguage: 'en-AU', proxyLanguage: 'en_AU' },
  { label: 'India (amazon.in)', amazonPage: 'amazon.in', baseAmazonPage: 'amazon.com', acceptLanguage: 'en-IN', proxyLanguage: 'en_IN' },
  { label: 'Germany (amazon.de)', amazonPage: 'amazon.de', baseAmazonPage: 'amazon.com', acceptLanguage: 'de-DE', proxyLanguage: 'de_DE' },
  { label: 'France (amazon.fr)', amazonPage: 'amazon.fr', baseAmazonPage: 'amazon.com', acceptLanguage: 'fr-FR', proxyLanguage: 'fr_FR' },
  { label: 'Italy (amazon.it)', amazonPage: 'amazon.it', baseAmazonPage: 'amazon.com', acceptLanguage: 'it-IT', proxyLanguage: 'it_IT' },
  { label: 'Spain (amazon.es)', amazonPage: 'amazon.es', baseAmazonPage: 'amazon.com', acceptLanguage: 'es-ES', proxyLanguage: 'es_ES' },
  { label: 'Mexico (amazon.com.mx)', amazonPage: 'amazon.com.mx', baseAmazonPage: 'amazon.com', acceptLanguage: 'es-MX', proxyLanguage: 'es_MX' },
  { label: 'Brazil (amazon.com.br)', amazonPage: 'amazon.com.br', baseAmazonPage: 'amazon.com', acceptLanguage: 'pt-BR', proxyLanguage: 'pt_BR' },
  { label: 'Japan (amazon.co.jp)', amazonPage: 'amazon.co.jp', baseAmazonPage: 'amazon.co.jp', acceptLanguage: 'ja-JP', proxyLanguage: 'ja_JP' },
];

const DEFAULT_REGION = REGIONS[0];

function findRegion(label) {
  return REGIONS.find((r) => r.label === label) || DEFAULT_REGION;
}

module.exports = { REGIONS, DEFAULT_REGION, findRegion };
