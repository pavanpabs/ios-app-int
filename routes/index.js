var express = require('express');
var router = express.Router();
const cbor = require('cbor')
var crypto = require("crypto");
const base64url = require('base64url');
const asn1      = require('@lapo/asn1js');
const jsrsasign = require('jsrsasign');

/* Apple Webauthn Root
 * Original is here https://www.apple.com/certificateauthority/Apple_WebAuthn_Root_CA.pem
 */
let appleWebAuthnRoot = 'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD';

let COSEKEYS = {
    'kty' : 1,
    'alg' : 3,
    'crv' : -1,
    'x'   : -2,
    'y'   : -3,
    'n'   : -1,
    'e'   : -2
}

/* GET home page. */
router.post("/attest", function (req, res, next) {
  const clientDataBuffer = req.body.clientDataBuffer;
  const assertionBuffer = req.body.assertionBuffer;
  
  try {
    console.log(assertionBuffer);
    let assert = cbor.decodeAllSync(assertionBuffer)[0];
    console.log(assert);
    let authData = assert.authenticatorData; // buffer
    let signature = assert.signature; // buffer
    // compute client Data Hash
    let clientDataHash = crypto
      .createHash("sha256")
      .update(clientDataBuffer)
      .digest("base64");
    let clientDataHashBuffer = Buffer.from(clientDataHash, "base64");
    // compute composite hash
    let compositeBuffer = Buffer.concat([authData, clientDataHashBuffer]);
    let nonce = crypto
      .createHash("sha256")
      .update(compositeBuffer)
      .digest("base64"); // base64 string
    let nonceBuffer = Buffer.from(nonce, "base64");
    // load public key
    let keyObj = crypto.createPublicKey(k_publicKeyPem);
    // verify signature
    let verifier = crypto.createVerify("sha256").update(nonceBuffer);
    let sign_verify = verifier.verify(keyObj, signature);
    console.log("sign_verify: ", sign_verify);
    res.send({"sign_verify":sign_verify});
  } catch (e) {
    console.log(e);
  }
});

router.post("/attest-new", function (req, res, next) {
  // console.log(req.body);
  try {
    let sign_verify = verifyAppleAnonymousAttestation(req.body)
    res.send({"verification":sign_verify});
  } catch (error) {
    res.send({"-error":error});
  }
});

var hash = (alg, message) => {
  return crypto.createHash(alg).update(message).digest();
}

var base64ToPem = (b64cert) => {
  let pemcert = '';
  for(let i = 0; i < b64cert.length; i += 64)
      pemcert += b64cert.slice(i, i + 64) + '\n';

  return '-----BEGIN CERTIFICATE-----\n' + pemcert + '-----END CERTIFICATE-----';
}

var findOID = (asn1object, oid) => {
  if(!asn1object.sub)
      return

  for(let sub of asn1object.sub) {
      if(sub.typeName() !== 'OBJECT_IDENTIFIER' || sub.content() !== oid) {
          let result = findOID(sub, oid);

          if(result)
              return result

      } else {
          return asn1object
      }
  }
}

let asn1ObjectToJSON = (asn1object) => {
  let JASN1 = {
      'type': asn1object.typeName()
  }

  if(!asn1object.sub) {
      if(asn1object.typeName() === 'BIT_STRING' || asn1object.typeName() === 'OCTET_STRING')
          JASN1.data = asn1object.stream.enc.slice(asn1object.posContent(), asn1object.posEnd());
      else
          JASN1.data = asn1object.content();

      return JASN1
  }

  JASN1.data = [];
  for(let sub of asn1object.sub) {
      JASN1.data.push(asn1ObjectToJSON(sub));
  }

  return JASN1
}

let containsASN1Tag = (seq, tag) => {
  for(let member of seq)
      if(member.type === '[' + tag + ']')
          return true

  return false
}

var parseAuthData = (buffer) => {
  let rpIdHash      = buffer.slice(0, 32);          buffer = buffer.slice(32);
  let flagsBuf      = buffer.slice(0, 1);           buffer = buffer.slice(1);
  let flagsInt      = flagsBuf[0];
  let flags = {
      up: !!(flagsInt & 0x01),
      uv: !!(flagsInt & 0x04),
      at: !!(flagsInt & 0x40),
      ed: !!(flagsInt & 0x80),
      flagsInt
  }

  let counterBuf    = buffer.slice(0, 4);           buffer = buffer.slice(4);
  let counter       = counterBuf.readUInt32BE(0);

  let aaguid        = undefined;
  let credID        = undefined;
  let COSEPublicKey = undefined;

  if(flags.at) {
      aaguid           = buffer.slice(0, 16);          buffer = buffer.slice(16);
      let credIDLenBuf = buffer.slice(0, 2);           buffer = buffer.slice(2);
      let credIDLen    = credIDLenBuf.readUInt16BE(0);
      credID           = buffer.slice(0, credIDLen);   buffer = buffer.slice(credIDLen);
      COSEPublicKey    = buffer;
  }

  return {rpIdHash, flagsBuf, flags, counter, counterBuf, aaguid, credID, COSEPublicKey}
}

var getCertificateSubject = (certificate) => {
  let subjectCert = new jsrsasign.X509();
  subjectCert.readCertPEM(certificate);

  let subjectString = subjectCert.getSubjectString();
  let subjectFields = subjectString.slice(1).split('/');

  let fields = {};
  for(let field of subjectFields) {
      let kv = field.split('=');
      fields[kv[0]] = kv[1];
  }

  return fields
}

var validateCertificatePath = (certificates) => {
  if((new Set(certificates)).size !== certificates.length)
      throw new Error('Failed to validate certificates path! Dublicate certificates detected!');

  for(let i = 0; i < certificates.length; i++) {
      let subjectPem  = certificates[i];
      let subjectCert = new jsrsasign.X509();
      subjectCert.readCertPEM(subjectPem);

      let issuerPem = '';
      if(i + 1 >= certificates.length)
          issuerPem = subjectPem;
      else
          issuerPem = certificates[i + 1];

      let issuerCert = new jsrsasign.X509();
      issuerCert.readCertPEM(issuerPem);

      if(subjectCert.getIssuerString() !== issuerCert.getSubjectString())
          throw new Error('Failed to validate certificate path! Issuers dont match!');

      let subjectCertStruct = jsrsasign.ASN1HEX.getTLVbyList(subjectCert.hex, 0, [0]);
      let algorithm         = subjectCert.getSignatureAlgorithmField();
      let signatureHex      = subjectCert.getSignatureValueHex()

      let Signature = new jsrsasign.crypto.Signature({alg: algorithm});
      Signature.init(issuerPem);
      Signature.updateHex(subjectCertStruct);

      if(!Signature.verify(signatureHex))
          throw new Error('Failed to validate certificate path!')
  }

  return true
}

let verifyAppleAnonymousAttestation = (webAuthnResponse) => {
  try { 
  let attestationBuffer = base64url.toBuffer(webAuthnResponse.response.attestationObject);
  let attestationStruct = cbor.decodeAllSync(attestationBuffer)[0];

  // console.log(attestationStruct)

  let authDataStruct    = parseAuthData(attestationStruct.authData);
  console.log(webAuthnResponse.response.clientDataJSON,'auth');
  let clientDataHashBuf = hash('sha256', base64url.toBuffer(webAuthnResponse.response.clientDataJSON));

/* ----- VERIFY NONCE ----- */
  let signatureBaseBuffer     = Buffer.concat([attestationStruct.authData, clientDataHashBuf]);
  let expectedNonceBuffer     = hash('sha256', signatureBaseBuffer)

  let certASN1                = asn1.decode(attestationStruct.attStmt.x5c[0]);

  let AppleNonceExtension     = findOID(certASN1, '1.2.840.113635.100.8.2');

  if(!AppleNonceExtension)
      throw new Error('The certificate is missing Apple Nonce Extension 1.2.840.113635.100.8.2!')

  /*
      [
          {
              "type": "OBJECT_IDENTIFIER",
              "data": "1.2.840.113635.100.8.2"
          },
          {
              "type": "OCTET_STRING",
              "data": [
                  {
                      "type": "SEQUENCE",
                      "data": [
                          {
                              "type": "[1]",
                              "data": [
                                  {
                                      "type": "OCTET_STRING",
                                      "data": {
                                          "type": "Buffer",
                                          "data": [92, 219, 157, 144, 115, 64, 69, 91, 99, 115, 230, 117, 43, 115, 252, 54, 132, 83, 96, 34, 21, 250, 234, 187, 124, 22, 95, 11, 173, 172, 7, 204]
                                      }
                                  }
                              ]
                          }
                      ]
                  }
              ]
          }
      ]
   */
  let appleNonceExtensionJSON = asn1ObjectToJSON(AppleNonceExtension).data;

  let certificateNonceBuffer  = appleNonceExtensionJSON[1].data[0].data[0].data[0].data;

  console.log(certificateNonceBuffer,'certificateNonceBuffer');
  console.log(expectedNonceBuffer,'expectedNonceBufferexpectedNonceBuffer');

  if(Buffer.compare(certificateNonceBuffer, expectedNonceBuffer) !== 0)
      throw new Error('Attestation certificate does not contain expected nonce!');

/* ----- VERIFY NONCE ENDS ----- */

/* ----- VERIFY CERTIFICATE PATH ----- */

  let certPath = attestationStruct.attStmt.x5c
      .map((cert) => cert.toString('base64'))
      .map((cert) => base64ToPem(cert));

  certPath.push(base64ToPem(appleWebAuthnRoot))

  validateCertificatePath(certPath);
/* ----- VERIFY CERTIFICATE PATH ENDS ----- */


/* ----- VERIFY PUBLIC KEY MATCHING ----- */
  let certJSON       = asn1ObjectToJSON(certASN1);
  let certTBS        = certJSON.data[0];
  let certPubKey     = certTBS.data[6];
  let certPubKeyBuff = certPubKey.data[1].data;

  /* CHECK PUBKEY */
  let coseKey = cbor.decodeAllSync(authDataStruct.COSEPublicKey)[0];

  /* ANSI ECC KEY is 0x04 with X and Y coefficients. But certs have it padded with 0x00 so for simplicity it easier to do it that way */
  let ansiKey = Buffer.concat([Buffer([0x00, 0x04]), coseKey.get(COSEKEYS.x), coseKey.get(COSEKEYS.y)])

  if(ansiKey.toString('hex') !== certPubKeyBuff.toString('hex'))
      throw new Error('Certificate public key does not match public key in authData')
/* ----- VERIFY PUBLIC KEY MATCHING ENDS ----- */

  return true

} catch (error) {
    console.log(error);
}
}

module.exports = router;
