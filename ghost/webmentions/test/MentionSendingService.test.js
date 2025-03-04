const {MentionSendingService} = require('../');
const assert = require('assert');
const nock = require('nock');
// non-standard to use externalRequest here, but this is required for the overrides in the libary, which we want to test for security reasons in combination with the package
const externalRequest = require('../../core/core/server/lib/request-external.js');
const sinon = require('sinon');
const logging = require('@tryghost/logging');
const {createModel} = require('./utils/index.js');

// mock up job service
let jobService = {
    async addJob(name, fn) {
        return fn();
    }
};

describe('MentionSendingService', function () {
    let errorLogStub;

    beforeEach(function () {
        nock.disableNetConnect();
        sinon.stub(logging, 'info');
        errorLogStub = sinon.stub(logging, 'error');
    });

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    after(function () {
        nock.cleanAll();
        nock.enableNetConnect();
    });

    describe('listen', function () {
        it('Calls on post.published, post.published.edited, post.unpublished', async function () {
            const service = new MentionSendingService({});
            const stub = sinon.stub(service, 'sendForPost').resolves();
            let callback;
            const events = {
                on: sinon.stub().callsFake((event, c) => {
                    callback = c;
                })
            };
            service.listen(events);
            sinon.assert.calledThrice(events.on);
            await callback({});
            sinon.assert.calledOnce(stub);
        });
    });

    describe('sendForPost', function () {
        it('Ignores if disabled', async function () {
            const service = new MentionSendingService({
                isEnabled: () => false
            });
            const stub = sinon.stub(service, 'sendAll');
            await service.sendForPost({});
            sinon.assert.notCalled(stub);
        });

        it('Ignores if importing data', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true
            });
            const stub = sinon.stub(service, 'sendAll');
            let options = {importing: true};
            await service.sendForPost({}, options);
            sinon.assert.notCalled(stub);
        });

        it('Ignores if internal context', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true
            });
            const stub = sinon.stub(service, 'sendAll');
            let options = {context: {internal: true}};
            await service.sendForPost({}, options);
            sinon.assert.notCalled(stub);
        });

        it('Ignores draft posts', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true
            });
            const stub = sinon.stub(service, 'sendAll');
            await service.sendForPost(createModel({
                status: 'draft',
                html: 'changed',
                previous: {
                    status: 'draft',
                    html: ''
                }
            }));
            sinon.assert.notCalled(stub);
        });

        it('Ignores if html was not changed', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true
            });
            const stub = sinon.stub(service, 'sendAll');
            await service.sendForPost(createModel({
                status: 'published',
                html: 'same',
                previous: {
                    status: 'published',
                    html: 'same'
                }
            }));
            sinon.assert.notCalled(stub);
        });

        it('Ignores email only posts', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true
            });
            const stub = sinon.stub(service, 'sendAll');
            await service.sendForPost(createModel({
                status: 'send',
                html: 'changed',
                previous: {
                    status: 'draft',
                    html: 'same'
                }
            }));
            sinon.assert.notCalled(stub);
        });

        it('Sends on publish', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true,
                getPostUrl: () => 'https://site.com/post/',
                jobService: jobService
            });
            const stub = sinon.stub(service, 'sendAll');
            await service.sendForPost(createModel({
                status: 'published',
                html: 'same',
                previous: {
                    status: 'draft',
                    html: 'same'
                }
            }));
            sinon.assert.calledOnce(stub);
            const firstCall = stub.getCall(0).args[0];
            assert.strictEqual(firstCall.url.toString(), 'https://site.com/post/');
            assert.strictEqual(firstCall.html, 'same');
            assert.strictEqual(firstCall.previousHtml, null);
        });

        it('Sends on html change', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true,
                getPostUrl: () => 'https://site.com/post/',
                jobService: jobService
            });
            const stub = sinon.stub(service, 'sendAll');
            await service.sendForPost(createModel({
                status: 'published',
                html: 'updated',
                previous: {
                    status: 'published',
                    html: 'same'
                }
            }));
            sinon.assert.calledOnce(stub);
            const firstCall = stub.getCall(0).args[0];
            assert.strictEqual(firstCall.url.toString(), 'https://site.com/post/');
            assert.strictEqual(firstCall.html, 'updated');
            assert.strictEqual(firstCall.previousHtml, 'same');
        });

        it('Catches and logs errors', async function () {
            const service = new MentionSendingService({
                isEnabled: () => true,
                getPostUrl: () => 'https://site.com/post/'
            });
            sinon.stub(service, 'sendAll').rejects(new Error('Internal error test'));
            await service.sendForPost(createModel({
                status: 'published',
                html: 'same',
                previous: {
                    status: 'draft',
                    html: 'same'
                }
            }));
            assert(errorLogStub.calledTwice);
        });
    });

    describe('sendAll', function () {
        it('Sends to all links', async function () {
            let counter = 0;
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test')
                .reply(() => {
                    counter += 1;
                    return [202];
                });

            const service = new MentionSendingService({
                externalRequest,
                getSiteUrl: () => new URL('https://site.com'),
                discoveryService: {
                    getEndpoint: async () => new URL('https://example.org/webmentions-test')
                }
            });
            await service.sendAll({url: new URL('https://site.com'),
                html: `
                    <html>
                        <body>
                            <a href="https://example.com">Example</a>
                            <a href="https://example.com">Example repeated</a>
                            <a href="https://example.org#fragment">Example</a>
                            <a href="http://example2.org">Example 2</a>
                        </body>
                    </html>
            `});
            assert.strictEqual(scope.isDone(), true);
            assert.equal(counter, 3);
        });

        it('Catches and logs errors', async function () {
            let counter = 0;
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test')
                .reply(() => {
                    counter += 1;
                    if (counter === 2) {
                        return [500];
                    }
                    return [202];
                });

            const service = new MentionSendingService({
                externalRequest,
                getSiteUrl: () => new URL('https://site.com'),
                discoveryService: {
                    getEndpoint: async () => new URL('https://example.org/webmentions-test')
                }
            });
            await service.sendAll({url: new URL('https://site.com'),
                html: `
                    <html>
                        <body>
                            <a href="https://example.com">Example</a>
                            <a href="https://example.com">Example repeated</a>
                            <a href="https://example.org#fragment">Example</a>
                            <a href="http://example2.org">Example 2</a>
                        </body>
                    </html>
            `});
            assert.strictEqual(scope.isDone(), true);
            assert.equal(counter, 3);
            assert(errorLogStub.calledOnce);
        });

        it('Sends to deleted links', async function () {
            let counter = 0;
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test')
                .reply(() => {
                    counter += 1;
                    return [202];
                });

            const service = new MentionSendingService({
                externalRequest,
                getSiteUrl: () => new URL('https://site.com'),
                discoveryService: {
                    getEndpoint: async () => new URL('https://example.org/webmentions-test')
                },
                jobService: jobService
            });
            await service.sendAll({url: new URL('https://site.com'),
                html: `<a href="https://example.com">Example</a>`,
                previousHtml: `<a href="https://typo.com">Example</a>`});
            assert.strictEqual(scope.isDone(), true);
            assert.equal(counter, 2);
        });
    });

    describe('getLinks', function () {
        it('Returns all unique links in a HTML-document', async function () {
            const service = new MentionSendingService({
                getSiteUrl: () => new URL('https://site.com')
            });
            const links = service.getLinks(`
                <html>
                    <body>
                        <a href="https://example.com">Example</a>
                        <a href="https://example.com">Example repeated</a>
                        <a href="https://example.org#fragment">Example</a>
                        <a href="http://example2.org">Example 2</a>
                    </body>
                </html>
            `);
            assert.deepStrictEqual(links, [
                new URL('https://example.com'),
                new URL('https://example.org#fragment'),
                new URL('http://example2.org')
            ]);
        });

        it('Does not include invalid or local URLs', async function () {
            const service = new MentionSendingService({
                getSiteUrl: () => new URL('https://site.com')
            });
            const links = service.getLinks(`<a href="/">Example</a>`);
            assert.deepStrictEqual(links, []);
        });

        it('Does not include non-http protocols', async function () {
            const service = new MentionSendingService({
                getSiteUrl: () => new URL('https://site.com')
            });
            const links = service.getLinks(`<a href="ftp://invalid.com">Example</a>`);
            assert.deepStrictEqual(links, []);
        });

        it('Does not include invalid urls', async function () {
            const service = new MentionSendingService({
                getSiteUrl: () => new URL('https://site.com')
            });
            const links = service.getLinks(`<a href="()">Example</a>`);
            assert.deepStrictEqual(links, []);
        });

        it('Does not include urls from site domain', async function () {
            const service = new MentionSendingService({
                getSiteUrl: () => new URL('https://site.com')
            });
            const links = service.getLinks(`<a href="http://site.com/test?123">Example</a>`);
            assert.deepStrictEqual(links, []);
        });

        it('Ignores invalid site urls', async function () {
            const service = new MentionSendingService({
                getSiteUrl: () => new URL('invalid()')
            });
            const links = service.getLinks(`<a href="http://site.com/test?123">Example</a>`);
            assert.deepStrictEqual(links, [
                new URL('http://site.com/test?123')
            ]);
        });
    });

    describe('send', function () {
        it('Can handle 202 accepted responses', async function () {
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test', `source=${encodeURIComponent('https://example.com/source')}&target=${encodeURIComponent('https://target.com/target')}&source_is_ghost=true`)
                .reply(202);

            const service = new MentionSendingService({externalRequest});
            await service.send({
                source: new URL('https://example.com/source'),
                target: new URL('https://target.com/target'),
                endpoint: new URL('https://example.org/webmentions-test')
            });
            assert(scope.isDone());
        });

        it('Can handle 201 created responses', async function () {
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test', `source=${encodeURIComponent('https://example.com/source')}&target=${encodeURIComponent('https://target.com/target')}&source_is_ghost=true`)
                .reply(201);

            const service = new MentionSendingService({externalRequest});
            await service.send({
                source: new URL('https://example.com/source'),
                target: new URL('https://target.com/target'),
                endpoint: new URL('https://example.org/webmentions-test')
            });
            assert(scope.isDone());
        });

        it('Can handle 400 responses', async function () {
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test')
                .reply(400);

            const service = new MentionSendingService({externalRequest});
            await assert.rejects(service.send({
                source: new URL('https://example.com/source'),
                target: new URL('https://target.com/target'),
                endpoint: new URL('https://example.org/webmentions-test')
            }), /sending failed/);
            assert(scope.isDone());
        });

        it('Can handle 500 responses', async function () {
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test')
                .reply(500);

            const service = new MentionSendingService({externalRequest});
            await assert.rejects(service.send({
                source: new URL('https://example.com/source'),
                target: new URL('https://target.com/target'),
                endpoint: new URL('https://example.org/webmentions-test')
            }), /sending failed/);
            assert(scope.isDone());
        });

        it('Can handle network errors', async function () {
            const scope = nock('https://example.org')
                .persist()
                .post('/webmentions-test')
                .replyWithError('network error');

            const service = new MentionSendingService({externalRequest});
            await assert.rejects(service.send({
                source: new URL('https://example.com/source'),
                target: new URL('https://target.com/target'),
                endpoint: new URL('https://example.org/webmentions-test')
            }), /network error/);
            assert(scope.isDone());
        });

        // Redirects are currently not supported by got for POST requests!
        //it('Can handle redirect responses', async function () {
        //    const scope = nock('https://example.org')
        //        .persist()
        //        .post('/webmentions-test')
        //        .reply(302, '', {
        //            headers: {
        //                Location: 'https://example.org/webmentions-test-2'
        //            }
        //        });
        //    const scope2 = nock('https://example.org')
        //        .persist()
        //        .post('/webmentions-test-2')
        //        .reply(201);
        //
        //    const service = new MentionSendingService({externalRequest});
        //    await service.send({
        //        source: new URL('https://example.com'),
        //        target: new URL('https://example.com'),
        //        endpoint: new URL('https://example.org/webmentions-test')
        //    });
        //    assert(scope.isDone());
        //    assert(scope2.isDone());
        //});
        // TODO: also check if we don't follow private IPs after redirects

        it('Does not send to private IP', async function () {
            const service = new MentionSendingService({externalRequest});
            await assert.rejects(service.send({
                source: new URL('https://example.com/source'),
                target: new URL('https://target.com/target'),
                endpoint: new URL('http://localhost/webmentions')
            }), /non-permitted private IP/);
        });

        it('Does not send to private IP behind DNS', async function () {
            // Test that we don't make a request when a domain resolves to a private IP
            // domaincontrol.com -> 127.0.0.1
            const service = new MentionSendingService({externalRequest});
            await assert.rejects(service.send({
                source: new URL('https://example.com/source'),
                target: new URL('https://target.com/target'),
                endpoint: new URL('http://domaincontrol.com/webmentions')
            }), /non-permitted private IP/);
        });
    });
});
