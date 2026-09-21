import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localhostCertificatePolicy,
  isPemCertificateContentType,
  validateExistingCertificate,
  validateLegacyPemSecret,
} from "../lib/port-forward-certificate.mjs";

test("localhostCertificatePolicy creates a PEM self-signed localhost certificate", () => {
  const input = {
    issuerParameters: { name: "Unknown" },
    secretProperties: { contentType: "application/x-pkcs12" },
    x509CertificateProperties: {
      subject: "CN=example.test",
      subjectAlternativeNames: { dnsNames: ["example.test"], emails: ["ops@example.test"] },
      validityInMonths: 6,
      keyUsage: ["digitalSignature"],
    },
  };

  const policy = localhostCertificatePolicy(input);

  assert.equal(policy.issuerParameters.name, "Self");
  assert.equal(policy.secretProperties.contentType, "application/x-pem-file");
  assert.equal(policy.x509CertificateProperties.subject, "CN=localhost");
  assert.deepEqual(policy.x509CertificateProperties.subjectAlternativeNames.dnsNames, ["localhost"]);
  assert.deepEqual(policy.x509CertificateProperties.subjectAlternativeNames.emails, ["ops@example.test"]);
  assert.equal(policy.x509CertificateProperties.validityInMonths, 12);
  assert.deepEqual(policy.x509CertificateProperties.keyUsage, ["digitalSignature"]);
  assert.equal(input.issuerParameters.name, "Unknown", "input policy must not be mutated");
});

test("isPemCertificateContentType recognizes only the CSI-compatible PEM type", () => {
  assert.equal(isPemCertificateContentType("application/x-pem-file\n"), true);
  assert.equal(isPemCertificateContentType("APPLICATION/X-PEM-FILE"), true);
  assert.equal(isPemCertificateContentType("application/x-pkcs12"), false);
  assert.equal(isPemCertificateContentType(""), false);
});

test("validateExistingCertificate requires PEM, localhost SAN, and a valid lifetime", () => {
  const valid = {
    attributes: {
      enabled: true,
      notBefore: "2026-01-01T00:00:00Z",
      expires: "2027-01-01T00:00:00Z",
    },
    policy: {
      secretProperties: { contentType: "application/x-pem-file" },
      x509CertificateProperties: {
        subjectAlternativeNames: { dnsNames: ["localhost"] },
      },
    },
  };
  const now = new Date("2026-09-21T00:00:00Z");
  assert.equal(validateExistingCertificate(valid, now), null);
  assert.match(
    validateExistingCertificate({
      ...valid,
      policy: {
        ...valid.policy,
        x509CertificateProperties: { subjectAlternativeNames: { dnsNames: ["portal.internal"] } },
      },
    }, now),
    /localhost/,
  );
  assert.match(
    validateExistingCertificate({
      ...valid,
      attributes: { ...valid.attributes, expires: "2026-01-02T00:00:00Z" },
    }, now),
    /expired/,
  );
});

test("validateLegacyPemSecret rejects metadata-only and malformed migration secrets", () => {
  assert.match(
    validateLegacyPemSecret({ contentType: "application/x-pkcs12", value: "unused" }),
    /content type/,
  );
  assert.match(
    validateLegacyPemSecret({
      contentType: "application/x-pem-file",
      value: "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
    }),
    /both a PEM certificate and an unencrypted private key/,
  );
});
