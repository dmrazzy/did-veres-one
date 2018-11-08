/*!
 * Copyright (c) 2018 Veres One Project. All rights reserved.
 */
'use strict';

const constants = require('./constants');
const VeresOneDidDoc = require('./veres-one-did-doc');
const Injector = require('./Injector');
const storage = require('./storage');
const VeresOneClient = require('./veres-one-client');

const DEFAULT_MODE = 'test';

class VeresOne {
  /**
   * @param [options={}] {object}
   *
   * @param [options.mode='test'] {string} Ledger mode ('test', 'dev', 'live'),
   *   determines hostname for ledger client.
   * @param [options.hostname] {string} Optional hostname override. If not
   *   provided, ledger hostname will be determined based on `mode`.
   *
   * @param [options.logger] {object} Optional logger (defaults to console)
   * @param [options.client] {WebLedgerClient}
   *
   * Storage defaults to file-based stores, can be substituted to in-memory
   * for testing.
   * @param [options.keyStore] {Store} Private key store
   * @param [options.didStore] {Store} Local DID Doc cache
   * @param [options.metaStore] {Store} DID Doc metadata store
   */
  constructor(options = {}) {
    this.injector = options.injector || new Injector();
    this.ledger = 'veres';
    this.mode = options.mode || DEFAULT_MODE;

    this.logger = options.logger || console;

    const hostname = options.hostname || VeresOne.defaultHostname(this.mode);
    this.client = options.client ||
      new VeresOneClient({
        hostname, injector: this.injector, mode: this.mode, logger: this.logger
      });

    this.keyStore = options.keyStore ||
      storage.keyStore({ledger: this.ledger, mode: this.mode});
    this.metaStore = options.metaStore ||
      storage.metaStore({ledger: this.ledger, mode: this.mode});
    this.didStore = options.didStore ||
      storage.didStore({ledger: this.ledger, mode: this.mode});
  }

  /**
   * @returns {string} Hostname for current mode (dev/live etc)
   */
  static defaultHostname(mode) {
    switch(mode) {
      case 'dev':
        return 'genesis.veres.one.localhost:42443';
      case 'test':
        return 'genesis.testnet.veres.one';
      case 'live':
        return 'veres.one';
      default:
        throw new Error(`Unknown mode: "${mode}".`);
    }
  }

  /**
   * Attaches proofs to an operation by either:
   *
   *  1. Using an Accelerator service, in which case an authorization DID
   *     Document is required beforehand (typically obtained in exchange for
   *     payment). Or,
   *  2. Attaching an Equihash proof of work (requires time).
   *
   * @param operation {object} WebLedger operation
   *
   * @param options {object}
   *
   * @param [options.accelerator] {string} Hostname of accelerator to use
   * @param [options.authDoc] {VeresOneDidDoc} Auth DID Doc, required if using
   *   an accelerator service
   *
   * @param [options.notes]
   *
   * @returns {Promise<Operation>} an operation document with proofs attached.
   */
  async attachProofs({operation, options}) {
    const {didDocument} = options;

    if(options.accelerator) {
      // send operation to an accelerator for proof
      this.logger.log('Sending to accelerator for proof:', options.accelerator);
      operation = await this.attachAcceleratorProof({operation, ...options});
    } else {
      // attach an equihash proof
      this.logger.log('Generating Equihash proof of work... (60-120 seconds)');
      operation = await this.attachEquihashProof({operation});
    }

    // get private key
    const invokeKeyId = didDocument.doc.capabilityInvocation[0].publicKey[0].id;
    const creator = invokeKeyId;
    const invokeKey = didDocument.keys[invokeKeyId];
    if(!invokeKey.privateKey) {
      throw new Error('Invocation key required to perform a send.');
    }

    const privateKey = await invokeKey.export();

    // attach capability invocation proof
    const capabilityAction = operation.type.startsWith('Create')
      ? 'RegisterDid'
      : 'UpdateDidDocument';

    operation = await this.attachInvocationProof({
      operation,
      capability: didDocument.id,
      capabilityAction,
      creator,
      privateKeyPem: privateKey.privateKeyPem,
      privateKeyBase58: privateKey.privateKeyBase58,
    });

    return operation;
  }

  /**
   * Fetches a DID Document for a given DID. First checks the ledger, and if
   * not found, also checks local DID storage (for pairwise DIDs).
   *
   * @param did {string} URI of a DID, either registered on a ledger, or
   *   unregistered (pairwise cryptonym DID).
   *
   * @param [autoObserve=false] {boolean} Start tracking changes to the DID Doc
   *   (to generate a diff patch later).
   *
   * @throws {Error}
   *
   * @returns {Promise<VeresOneDidDoc>}
   */
  async get({did, autoObserve = false}) {
    let result;

    try {
      // First, try fetching DID Document from ledger
      result = await this.client.get({did});
    } catch(error) {
      if(!error.response || error.response.status !== 404) {
        throw error; // Re-throw (a non-404) error
      }
      // DID was not found on ledger, it may be an unregistered/pairwise
      // DID, so check local DID storage
      const localDidDoc = await this.didStore.get(did);
      if(!localDidDoc) {
        throw error; // local DID not found, re-throw the 404
      }
      result = {
        doc: localDidDoc,
        // @todo: Figure out the correct/official way to denote this, possibly
        // open an issue at https://github.com/w3c-ccg/did-resolution/issues/
        meta: {pairwise: true}
      };
    }

    const didDoc = new VeresOneDidDoc({injector: this.injector, ...result});
    const keysData = await this.keyStore.get(did);

    if(keysData) {
      didDoc.importKeys(keysData);
    }

    if(autoObserve) {
      didDoc.observe();
    }

    return didDoc;
  }

  /**
   * Generates a new DID Document with relevant keys, saves keys in key store.
   *
   * @param options
   * @param [options.didType='nym'] {string} DID type, 'nym' or 'uuid'
   *
   * @throws {Error}
   *
   * @returns {Promise<VeresOneDidDoc>}
   */
  async generate({didType = 'nym', keyType = constants.DEFAULT_KEY_TYPE,
    passphrase = null, env = 'dev'} = {}) {
    const didDoc = await VeresOneDidDoc.generate({didType, keyType, passphrase,
      env, injector: this.injector});

    await this.saveKeys(didDoc);
    await this.saveDoc(didDoc);

    return didDoc;
  }

  /**
   * Saves all the keys (public and private) in the key store.
   *
   * @param didDoc
   *
   * @returns {Promise}
   */
  async saveKeys(didDoc) {
    return this.keyStore.put(didDoc.id, await didDoc.exportKeys());
  }

  async saveDoc(didDoc) {
    return this.didStore.put(didDoc.id, didDoc);
  }

  /**
   * Registers a DID Document on the Veres One ledger.
   *
   * @param options {object} Options hashmap, see `send()` docstring.
   *
   * @returns {Promise<object>} Result of the register operation.
   */
  async register(options) {
    const {didDocument} = options;

    // wrap DID Document in a web ledger operation
    const operation = this.client.wrap(
      {didDocument: didDocument.doc, operationType: 'create'}
    );
    await this.send(operation, options);

    return didDocument;
  }

  /**
   * Records an update to a DID Document on the Veres One ledger.
   *
   * @param options {object} Options hashmap, see `send()` docstring.
   *
   * @returns {Promise<object>} Result of the update operation.
   */
  async update(options) {
    const operation = this.client.wrap(
      {didDocument: options.didDocument.doc, operationType: 'update'}
    );
    return this.send(operation, options);
  }

  /**
   * Sends a DID Document operation (register/update) the Veres One ledger
   * by either:
   *
   *  1. Using an Accelerator service, in which case an authorization DID
   *     Document is required beforehand (typically obtained in exchange for
   *     payment). Or,
   *  2. Attaching an Equihash proof of work (requires time).
   *
   * @param operation {object} WebLedger operation
   *
   * @param options {object}
   *
   * @param options.didDocument {VeresOneDidDoc} Document to update
   *
   * @param [options.accelerator] {string} Hostname of accelerator to use
   * @param [options.authDoc] {VeresOneDidDoc} Auth DID Doc, required if using
   *   an accelerator service
   *
   * @param [options.notes]
   *
   * @returns {Promise}
   */
  async send(operation, options) {
    this.logger.log('Sending to ledger, operation type:', operation.type);
    const {didDocument} = options;

    operation = await this.attachProofs({operation, options});

    // get private key
    const invokeKeyId = didDocument.doc.capabilityInvocation[0].publicKey[0].id;
    const authKey = didDocument.keys[invokeKeyId];

    const response = await this.client.send({operation, authKey, ...options});

    if(operation.type === 'create') {
      this.logger.log('DID registration sent to ledger.');
    } else {
      this.logger.log('DID Document update sent to the Veres One ledger.');
    }

    if(options.notes) {
      // save ledger if requested
      this.meta.saveNotes(didDocument, options);
    }
    return response;
  }

  /**
   * Sends a ledger operation to an accelerator.
   * Required when registering a DID Document (and not using an Equihash proof).
   *
   * @param options {object}
   *
   * @returns {Promise<object>} Response from an axios POST request
   */
  async attachAcceleratorProof(options) {
    let authKey;

    try {
      authKey = options.authDoc.doc.authentication[0];
    } catch(error) {
      throw new Error('Missing or invalid Authorization DID Doc.');
    }

    // send DID Document to a Veres One accelerator
    this.logger.log('Generating accelerator signature...');
    return this.client.sendToAccelerator({
      operation: options.operation,
      hostname: options.accelerator,
      env: options.mode,
      authKey
    });
  }

  /**
   * Adds an ocap invocation proof to an operation.
   *
   * TODO: support `passphrase` for encrypted private key pem or keep decrypt
   * as the responsibility of the caller?
   *
   * FIXME: use ldocap.js
   *
   * @returns {Promise<object>}
   */
  attachInvocationProof({operation, capability, capabilityAction, creator,
    algorithm, privateKeyPem, privateKeyBase58}) {
    // FIXME: use `algorithm` and validate private key, do not switch off of it
    if(privateKeyPem) {
      algorithm = 'RsaSignature2018';
    } else {
      algorithm = 'Ed25519Signature2018';
    }

    // FIXME: validate operation, capability, creator, and privateKeyPem
    // TODO: support `signer` API as alternative to `privateKeyPem`
    const jsigs = this.injector.use('jsonld-signatures');
    return jsigs.sign(operation, {
      algorithm,
      creator,
      privateKeyPem,
      privateKeyBase58,
      proof: {
        '@context': constants.VERES_ONE_CONTEXT_URL,
        proofPurpose: 'capabilityInvocation',
        capability,
        capabilityAction
      }
    });
  }

  /**
   * Adds an Equihash proof of work to an operation.
   *
   * @returns {Promise}
   */
  attachEquihashProof({operation, env = 'dev', parameters}) {
    let nParam;
    let kParam;
    if(parameters) {
      if(!(typeof parameters.n === 'number' &&
          typeof parameters.k === 'number')) {
        throw new TypeError(
          '`parameters.n` and `parameters.k` must be integers.');
      }
      nParam = parameters.n;
      kParam = parameters.k;
    } else {
      switch(env) {
        case 'dev':
        case 'test':
          nParam = 64;
          kParam = 3;
          break;
        case 'live':
          // FIXME: determine from ledger config
          nParam = 144;
          kParam = 5;
          break;
        default:
          throw new Error('"env" must be "dev", "test", or "live".');
      }
    }

    const jsigs = this.injector.use('jsonld-signatures');
    return jsigs.sign(operation, {
      algorithm: 'EquihashProof2018',
      parameters: {
        n: nParam,
        k: kParam
      }
    });
  }

  /**
   * Adds an ocap delegation proof to a capability DID Document.
   *
   * TODO: support `passphrase` for encrypted private key pem or keep decrypt
   *   as the responsibility of the caller?
   * FIXME: use ldocap.js
   */
  attachDelegationProof({didDocument, creator, privateKeyPem}) {
    // FIXME: validate didDocument, creator, and privateKeyPem
    // TODO: support `signer` API as alternative to `privateKeyPem`
    const jsigs = this.injector.use('jsonld-signatures');
    return jsigs.sign(didDocument.doc, {
      algorithm: 'RsaSignature2018',
      creator,
      privateKeyPem,
      proof: {
        '@context': constants.VERES_ONE_CONTEXT_URL,
        proofPurpose: 'capabilityDelegation'
      }
    });
  }
}

VeresOne.contexts = {
  [constants.VERES_ONE_CONTEXT_URL]: require('veres-one-context')
};

module.exports = VeresOne;