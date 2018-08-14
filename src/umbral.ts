import bigInt = require('big-integer')
import * as encoding from 'text-encoding';
import uuidv4 = require('uuid/v4');

export interface IRecord {
  readonly perpId: string; 
  readonly userId: string;
}

export interface IEncryptedData {
  readonly id: string; // id
  readonly matchingIndex: string; // pi
  readonly eOC: string; // c
  readonly eUser: string; // c'user
  eRecord: string;
}

interface IShare {
  readonly x: bigInt.BigInteger;
  readonly y: bigInt.BigInteger
  readonly eRecordKey: string;
}

interface IDerivedValues {
  readonly slope: bigInt.BigInteger;
  readonly k: Uint8Array;
  readonly matchingIndex: string
}

export interface IMalformed {
  readonly id: string;
  readonly error: string;
}

export interface IDecryptedData {
  readonly records: IRecord[];
  readonly malformed: IMalformed[]; // ids
}

export class umbral {
  private sodium = null;

  private HEX: number = 16;
  private PRIME: bigInt.BigInteger = bigInt(
    '115792089237316195423570985008687907853269984665640564039457584007913129639936',
  ).plus(bigInt(297));

  private KEY_BYTES: number = 32;
  private RECORD_STRING: string = 'record';
  private RECORD_KEY_STRING: string = 'record key';
  private USER_EDIT_STRING: string = 'user edit';

  /**
   * Initializes sodium
   * @param sodium initialized sodium instance
   */
  constructor(sodium) {
    this.sodium = sodium;
  }

  private deriveValues(randId: Uint8Array): IDerivedValues {

    try {
      const a: Uint8Array = this.sodium.crypto_kdf_derive_from_key(this.KEY_BYTES, 1, "slope derivation", randId);
      const k: Uint8Array = this.sodium.crypto_kdf_derive_from_key(this.KEY_BYTES, 2, "key derivation", randId);
      const ak: Uint8Array = this.sodium.crypto_generichash(this.KEY_BYTES, this.sodium.to_base64(a) + this.sodium.to_base64(k)); 
      const matchingIndex: string = this.sodium.to_base64(this.sodium.crypto_kdf_derive_from_key(this.KEY_BYTES, 3, "matching index derivation", ak));

      const slope: bigInt.BigInteger = bigInt(this.bytesToString(a));
      return {
        slope, k, matchingIndex
      }  
    } catch(e) {
      throw new Error('Key derivation failure');
    }

  }

   /**
    * Encrypts a user's record
    * @param {Uint8Array} randId - random ID (pHat)
    * @param {IRecord} record - user record
    * @param {Uint8Array[]} pkOCs - options counselor public keys
    * @param {Uint8Array} skUser - user's secret key
    * @returns {IEncryptedData[]} an array of records encrypted under each public key
    */
  public encryptData(randId: Uint8Array, record: IRecord, pkOCs: Uint8Array[], userPassPhrase: Uint8Array): IEncryptedData[] {
    if (pkOCs.length < 1) {
      throw new Error('No OC public key provided');
    }

    const derived: IDerivedValues = this.deriveValues(randId);
    const U: bigInt.BigInteger = bigInt(this.sodium.to_hex(this.sodium.crypto_generichash(this.KEY_BYTES, record.userId)), this.HEX);
    const kStr: string = this.bytesToString(derived.k);
    const s: bigInt.BigInteger = (derived.slope.times(U).plus(bigInt(kStr))).mod(this.PRIME);
    const recordKey: Uint8Array = this.sodium.crypto_secretbox_keygen();

    // TODO: change AD to fixed string concatenated with pi. *make sure they are different so they can't be swapped
    const eRecordKey: string = this.symmetricEncrypt(derived.k, this.sodium.to_base64(recordKey), this.RECORD_KEY_STRING + derived.matchingIndex);
    const eUser: string = this.symmetricEncrypt(userPassPhrase, this.sodium.to_base64(recordKey), this.USER_EDIT_STRING + derived.matchingIndex);
    
    const msg: IShare = { 
      x: U, 
      y: s, 
      eRecordKey };

    let encryptedData: IEncryptedData[] = [];

    const eRecord: string = this.symmetricEncrypt(recordKey, JSON.stringify(record), this.RECORD_STRING + derived.matchingIndex);
    
    for (const i in pkOCs) {
      let eOC = this.asymmetricEncrypt(JSON.stringify(msg), pkOCs[i]);
      const id: string = uuidv4();
      encryptedData.push({id, matchingIndex: derived.matchingIndex, eOC, eRecord, eUser});
    }

    return encryptedData;
  }  

  /**
   * Mathematically correct mod over a prime
   * @param {bigInt.BigInteger} val - input value 
   * @returns {bigInt.BigInteger}
   */
  private realMod(val: bigInt.BigInteger): bigInt.BigInteger {
    return val.mod(this.PRIME).add(this.PRIME).mod(this.PRIME);
  }

  /**
   * Computes a slope using two points
   * @param {IShare} c1 - 1st coordinate
   * @param {IShare} c2 - 2nd coordinate
   * @returns {bigInt.BigInteger} slope value
   */
  private deriveSlope(c1: IShare, c2: IShare): bigInt.BigInteger {
    const top: bigInt.BigInteger = this.realMod(c2.y.minus(c1.y));
    const bottom: bigInt.BigInteger = this.realMod(c2.x.minus(c1.x));

    return top.multiply(bottom.modInv(this.PRIME)).mod(this.PRIME);
  }

  /**
   * Checks that all entries have matching index
   * @param encryptedData 
   */
  private checkMatches(encryptedData): IMalformed[] {
    let malformed: IMalformed[] = [];
    let matchingDict: Object = {};

    if (encryptedData.length < 2) {
      return [{
        id: '',
        error: 'Decryption requires at least 2 matches'
      }];
    }

    var m = encryptedData[0].matchingIndex;
    
    for (var i = 0; i < encryptedData.length; i++) {
      let index = encryptedData[i].matchingIndex;

      if (index in matchingDict) {
        matchingDict[index].push(encryptedData[i].id);        
      } else {
        matchingDict[index] = [encryptedData[i].id];
      }
    }

    for (let index in matchingDict) {
      if (matchingDict[index].length === 1) {
        malformed.push({
          id: matchingDict[index][0],
          error: 'Matching index does not match with other shares'
        })
      }
    }
    return malformed;
  }

  /**
   * Decrypts a user's record for editing purposes 
   * @param {Uint8Array} userPassPhrase - original passphrase used to encrypt the record key
   * @param {IEncryptedData[]} userEncryptedData - a user's record encrypted under each OC public key
   * @returns {IRecord[]} an array of decrypted records (should contain same content)
   */
  public decryptUserRecord(userPassPhrase: Uint8Array, userEncryptedData: IEncryptedData[]): IDecryptedData {

    // NOTE: is it necessary to do this for ALL oc keys?
    const records: IRecord[] = [];
    const malformed: IMalformed[] = [];

    for (let i in userEncryptedData) {
      const eUser = userEncryptedData[i].eUser;

      try {
        const recordKey: Uint8Array = this.symmetricDecrypt(userPassPhrase, eUser, 
                                      this.USER_EDIT_STRING + userEncryptedData[i].matchingIndex);
        records.push(this.decryptRecord(this.sodium.from_base64(recordKey), userEncryptedData[i].eRecord, 
                      this.RECORD_STRING + userEncryptedData[i].matchingIndex));

      } catch(e) {
        malformed.push({
          id: userEncryptedData[i].id,
          error: e,
        })
        continue;
      }
    }
    return { records, malformed }
  }

  /**
   * 
   * @param {Uint8Array} userPassPhrase - original passphrase used to encrypt the record key
   * @param {IEncryptedData[]} userEncryptedData - a user's record encrypted under each OC public key
   * @param {IRecord} updatedRecord - a user's updated record
   * @returns {IEncryptedData[]} an array of encrypted data containing the cipher text of the updated record
   */
  public updateUserRecord(userPassPhrase: Uint8Array, userEncryptedData: IEncryptedData[], updatedRecord: IRecord): IMalformed[] {
    let malformed: IMalformed[] = [];

    for (let i in userEncryptedData) {
      const eUser = userEncryptedData[i].eUser;
      try {
        const recordKey: Uint8Array = this.symmetricDecrypt(userPassPhrase, eUser, this.USER_EDIT_STRING + userEncryptedData[i].matchingIndex);
        userEncryptedData[i].eRecord = this.symmetricEncrypt(this.sodium.from_base64(recordKey), JSON.stringify(updatedRecord), this.RECORD_STRING + userEncryptedData[i].matchingIndex);
      } catch(e) {
        malformed.push({
          id: userEncryptedData[i].id,
          error: e
        });

      }
    }
    return malformed;
  }
 

  private interpolateShares(s1: IShare, s2: IShare): Uint8Array {
    
    const slope: bigInt.BigInteger = this.deriveSlope(s1, s2);
    const intercept: bigInt.BigInteger = this.getIntercept(s1, slope);

    return this.stringToBytes(intercept.toString());

  }

  /**
   * Decrypts an array of encrypted data
   * @param {IEncryptedData[]} encryptedData - an array of encrypted data of matched users
   * @param {Uint8Array} skOC - secret key of an options counselor
   * @param {Uint8Array[]} pkUser - user's public key
   * @returns {IRecord[]} array of decrypted records from matched users
   */
  public decryptData(encryptedData: IEncryptedData[], skOC: Uint8Array, pkOC: Uint8Array): IDecryptedData {

    let malformed: IMalformed[] = this.checkMatches(encryptedData);

    if (malformed.length === encryptedData.length) {
      return {
        records: [],
        malformed
      }
    }

    let shares: object = {};
    let records: IRecord[] = [];

    for (let i in encryptedData) {
      try {
        let id = encryptedData[i].id;
        shares[id] = this.asymmetricDecrypt(encryptedData[i], skOC, pkOC);
      } catch (e) {
        malformed.push({
          id: encryptedData[i].id,
          error: e
        });     
      }
    }

    if (encryptedData.length < 2) return {records, malformed};

    var encryptedDict: object = {};
    for (var i = 0; i < encryptedData.length; i++) {
      var id = encryptedData[i].id;
      encryptedDict[id] = encryptedData[i];
    }

    const decryptedDict: object = {};
    while (Object.keys(shares).length > 0) {
      

      let ids = Object.keys(shares);
      let shareId = ids[0];
      let share = shares[ids[0]];

      for (var id in decryptedDict) {
        try {
          let s2: IShare = decryptedDict[id];
          const k: Uint8Array = this.interpolateShares(share, s2);
          const recordKey: Uint8Array = this.symmetricDecrypt(k, share.eRecordKey, 
                                                              this.RECORD_KEY_STRING + encryptedDict[shareId].matchingIndex);
          records.push(this.decryptRecord(this.sodium.from_base64(recordKey), encryptedDict[shareId].eRecord, 
                                          this.RECORD_STRING + encryptedDict[shareId].matchingIndex));

          decryptedDict[shareId] = share;
          break;

        } catch(e) {
        }
      
      }


      for (let i = 1; i < ids.length; i++) {
        try {
          let s2: IShare = shares[ids[i]];
          let s2Id: string = ids[i];
          const k: Uint8Array = this.interpolateShares(share, s2);

          // decrypt share 1
          let recordKey: Uint8Array = this.symmetricDecrypt(k, share.eRecordKey, 
                                        this.RECORD_KEY_STRING + encryptedDict[shareId].matchingIndex);

          records.push(this.decryptRecord(this.sodium.from_base64(recordKey), encryptedDict[shareId].eRecord, 
                      this.RECORD_STRING + encryptedDict[shareId].matchingIndex));

          decryptedDict[shareId] = share;

          // decrypt share 2
          recordKey = this.symmetricDecrypt(k, s2.eRecordKey, 
            this.RECORD_KEY_STRING + encryptedDict[s2Id].matchingIndex);
          records.push(this.decryptRecord(this.sodium.from_base64(recordKey), encryptedDict[s2Id].eRecord, 
          this.RECORD_STRING + encryptedDict[s2Id].matchingIndex));
          decryptedDict[ids[i]] = s2;

          delete shares[s2Id];
          break;
          
        } catch(e) {
          malformed.push({
            id: shareId,
            error: e
          });
        }
      }
      delete shares[ids[0]];
    }

    return {
      records,
      malformed
    }    
  }


  /**
   * Symmetric decryption
   * @param {Uint8Array} key 
   * @param {string} cipherText - in base 64 encoding with a nonce split on ("$")
   * @return {Uint8Array} decrypted data
   */
  private symmetricDecrypt(key: Uint8Array, cipherText: string, ad: string): Uint8Array {
    try {
      const split: string[] = cipherText.split("$");

      if (key.length !== this.sodium.crypto_box_SECRETKEYBYTES) {
        throw new Error('Improper key length for symmetric decryption');
      }
  
      const cT: Uint8Array = this.sodium.from_base64(split[0]);
      const nonce: Uint8Array = this.sodium.from_base64(split[1]);

      const decrypted: Uint8Array = this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, cT, ad, nonce, key);

      return decrypted;
    } catch (e) {
      // TODO: log & continue
      throw e;
    }
  }

  /**
   * Decrypts a single record
   * @param {Uint8Array} recordKey 
   * @param {string} eRecord 
   * @returns {IRecord} decrypted record
   */
  private decryptRecord(recordKey: Uint8Array, eRecord, ad: string): IRecord {
    // TODO: add associated data
    const decryptedRecord: Uint8Array = this.symmetricDecrypt(recordKey, eRecord, ad);
    const dStr: string = new encoding.TextDecoder("utf-8").decode(decryptedRecord);
    return JSON.parse(dStr);
  }

  /**
   * Converts a string representation of a number to a Uint8Array of bytes
   * @param str - string representation
   * @returns {Uint8Array}
   */
  private stringToBytes(str: string): Uint8Array {
    let value: bigInt.BigInteger = bigInt(str);
    const result: number[] = [];

    for (let i: number = 0; i < 32; i++) {
      result.push(parseInt(value.and(255).toString(), 10));
      value = value.shiftRight(8);
    }

    return Uint8Array.from(result);
  }

  /**
   * Calculates the y-intercept using a coordinate and slope
   * @param {IShare} c1 - a coordinate
   * @param {bigInt.BigInteger} slope 
   * @returns {bigInt.BigInteger} y-intercept
   */
  private getIntercept(c1: IShare, slope: bigInt.BigInteger): bigInt.BigInteger {
    const x: bigInt.BigInteger = c1.x;
    const y: bigInt.BigInteger = c1.y;
    const mult: bigInt.BigInteger = (slope.times(x));

    return this.realMod(y.minus(mult));
  }

  /**
   * Asymmetric decryption
   * @param {IEncryptedData} encryptedData 
   * @param {Uint8Array} skOC - secret key of an options counselor
   * @param {Uint8Array} pkUser - public key of a user
   * @returns {IShare} a decrypted coordinate
   */
  private asymmetricDecrypt(encryptedData: IEncryptedData, skOC: Uint8Array, pkOC: Uint8Array): IShare {

    try {
      const c: Uint8Array = this.sodium.from_base64(encryptedData.eOC);
      const msg: Uint8Array = this.sodium.crypto_box_seal_open(c, pkOC, skOC);
      const msgObj: IShare = JSON.parse(new encoding.TextDecoder("utf-8").decode(msg));  
      
      return {
        x: bigInt(msgObj.x),
        y: bigInt(msgObj.y),
        eRecordKey: msgObj.eRecordKey
      };
    } catch(e) {
      // TODO: log & continue
      throw e;
    }
  }

  /**
   * Asymmetric encryption
   * @param {string} message - a plaintext string
   * @param {Uint8Array} pkOC - the public key of an options counselor
   * @param {Uint8Array} skUser - secret key of a user
   * @returns {string} encrypted string in base 64 encoding 
   */
  private asymmetricEncrypt(message: string, pkOC: Uint8Array): string {

    try {
      const nonce: Uint8Array = this.sodium.randombytes_buf(this.sodium.crypto_box_NONCEBYTES);
      const cT: Uint8Array = this.sodium.crypto_box_seal(message, pkOC);
      return this.sodium.to_base64(cT);      
    } catch(e) {
      throw(e);
    }
  }

  /**
   * Symmetric encryption
   * @param {Uint8Array} key  
   * @param {string} msg plaintext string
   * @returns {string} encrypted string in base 64 encoding
   */
  private symmetricEncrypt(key: Uint8Array, msg: string, ad: string): string {
    try {
      const nonce: Uint8Array = this.sodium.randombytes_buf(this.sodium.crypto_box_NONCEBYTES);

      // TODO: double check that args are in correct order
      const cT: Uint8Array = this.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, ad, null, nonce, key);
      const encrypted: string = this.sodium.to_base64(cT) + "$" + this.sodium.to_base64(nonce);

      return encrypted;
    } catch(e) {
      throw e;
    }
  }

  /**
   * Converts bytes to their string representation of a number
   * @param {Uint8Array} bytes 
   * @returns {string}
   */
  private bytesToString(bytes: Uint8Array): string {
    let result: bigInt.BigInteger = bigInt(0);

    for (let i: number = bytes.length - 1; i >= 0; i--) {
      result = result.or(bigInt(bytes[i]).shiftLeft((i * 8)));
    }

    return result.toString();
  }
}