const { Sessions } = require('./session')
const { newId } = require('../lib/id-util')

function quotaImportance(quota) {
    const paid = quota.paid
    const delegated = quota.delegate
    return (paid ? 8 : 0) + (delegated ? 4 : 0)
}

function pickLeastImportant(quotas, n = 1) {
    return quotas.sort((a, b) => quotaImportance(a) - quotaImportance(b)).slice(0, n)
}

async function syncQuotaToSchool(ctx, school) {
    await Sessions(ctx)

    const current = await ctx.db.collection('ng-quota').find({ school, active: true }).toArray()
    let ret = {}
    for (let session of ctx.sessions)
        ret[session._id] = current.filter($ => $.session === session._id).length

    await ctx.db.collection('school').updateOne(
        { _id: school },
        { $set: { 'ng-quota': ret } }
    )

    return ret
}

// TODO: remove processInternal after merge into mainline
async function setQuota(ctx, school, quota) {
    await Sessions(ctx)

    const current = await ctx.db.collection('ng-quota').find({ school, active: true }).toArray()
    const delta = ctx.sessions
        .filter(session => !session._id.startsWith('_'))
        .map(session => {
            const currentNum = current.filter($ => $.session === session._id).length
            const targetNum = quota[session._id]
            return {
                session: session._id,
                delta: targetNum !== undefined && targetNum !== null ? targetNum - currentNum : 0
            }
        })
        .filter($ => $.delta)

    const positiveDelta = delta.filter($ => $.delta > 0)
    const negativeDelta = delta.filter($ => $.delta < 0)


    for (let positive of positiveDelta) {
        for (let i = 0; i !== positive.delta; ++ i) {
            await ctx.db.collection('ng-quota').insertOne({
                _id: newId(),
                school,
                session: positive.session,
                paid: false,
                active: true
            })
        }
    }

    for (let negative of negativeDelta) {
        const toDelete = pickLeastImportant(
            current.filter(quota => quota.session === negative.session),
            -negative.delta
        )

        // TODO: remove after merge to mainline
        if (toDelete.length < negative.delta) {
            await ctx.db.collection('ng-quota-error').insert({
                error: 'insufficient quota to delete',
                date: new Date(),
                args: {
                    current,
                    target: quota,
                    deltaEntry: negative
                }
            })
            return
        }

        for (let quota of toDelete) {
            // TODO: process quotas if associated with delegate
            await ctx.db.collection('ng-quota').updateOne(
                { _id: quota._id },
                { $set: { active: false, reason: 'deleted' } }
            )
        }
    }

    await syncQuotaToSchool(ctx, school)
}

async function syncSeatToQuota(ctx, schoolId) {
    const school = await ctx.db.collection('school').findOne({ _id: schoolId }, { seat: true })
    const seat1 = school && school.seat && school.seat['1'] || {}
    const seat2 = school && school.seat && school.seat['2'] || {}
    const sessions = [...new Set([...Object.keys(seat1), ...Object.keys(seat2)])]
    const target = {}
    for (let session of sessions)
        target[session] = (seat1[session] || 0) + (seat2[session] || 0)
    await setQuota(ctx, schoolId, target)
}

async function relinquishQuota(ctx, school, session) {
    const current = await ctx.db.collection('ng-quota').find({ school, session, active: true }).toArray()
    const toRelinquish = pickLeastImportant(current, 1)

    // TODO: remove after merge into mainline
    if (toRelinquish.length < 1) {
        await ctx.db.collection('ng-quota-error').insert({
            error: 'insufficient quota to relinquish',
            date: new Date(),
            args: {
                current,
                session
            }
        })
        return
    }

    await ctx.db.collection('ng-quota').updateOne(
        { _id: toRelinquish[0]._id },
        { $set: { active: false, reason: 'relinquish' } }
    )

    await syncQuotaToSchool(ctx, school)
}

async function exchangeQuota(ctx, left, right) {
    if (!left.school || !left.session || !right.school || !right.session)
        throw new Error('incorrect left / right operand')

    const lefts = await ctx.db.collection('ng-quota').find({ ...left, active: true }).toArray()
    const rights = await ctx.db.collection('ng-quota').find({ ...right, active: true }).toArray()

    const leftQuota = pickLeastImportant(lefts)[0]
    const rightQuota = pickLeastImportant(rights)[0]

    if (!leftQuota || !rightQuota) {
        // TODO: in production return 410
        return
    }

    // lock & give away left
    const {
        modifiedCount: modifiedLeft
    } = await ctx.db.collection('ng-quota').update(
        { _id: leftQuota._id, active: true },
        { $set: {
            active: false,
            state: 'in-exchange',
            school: rightQuota.school,
            session: rightQuota.session
        } }
    )

    // lock & give away right
    const {
        modifiedCount: modifiedRight
    } = await ctx.db.collection('ng-quota').update(
        { _id: rightQuota._id, active: true },
        { $set: {
            active: false,
            state: 'in-exchange',
            school: leftQuota.school,
            session: leftQuota.session
        } }
    )

    // restore if can't lock quota
    if (!modifiedLeft || !modifiedRight) {
        if (modifiedLeft) {
            await ctx.db.collection('ng-quota').update(
                { _id: leftQuota._id },
                { $set: {
                    active: true,
                    school: leftQuota.school,
                    session: leftQuota.session,
                    state: 'exchange-transaction-reverted'
                } }
            )
        }

        if (modifiedRight) {
            await ctx.db.collection('ng-quota').update(
                { _id: rightQuota._id },
                { $set: {
                    active: true,
                    school: rightQuota.school,
                    session: rightQuota.session,
                    state: 'exchange-transaction-reverted'
                } }
            )
        }
        // TODO: in production, return 410
    } else {
        // unlock quotas
        await ctx.db.collection('ng-quota').update(
            { _id: leftQuota._id },
            { $set: { active: true, state: 'exchanged' } }
        )
        await ctx.db.collection('ng-quota').update(
            { _id: rightQuota._id },
            { $set: { active: true, state: 'exchanged' } }
        )
        await syncQuotaToSchool(ctx, left.school)
        await syncQuotaToSchool(ctx, right.school)
    }
}

async function setLeaderAttend(ctx, school, attend) {
    const internal = 'leader-attendance'
    await ctx.db.collection('ng-quota').updateOne(
        {
            school,
            active: true,
            internal,
        }, {
            $set: {
                session: attend ? '_leader_r' : '_leader_nr'
            },
            $setOnInsert: {
                _id: newId(),
                school,
                active: true,
                internal,
                paid: false
            }
        }, {
            upsert: true
        }
    )
    await syncQuotaToSchool(ctx, school)
}

function neverFails(handler) {
    return async function NeverFailsWrap(ctx, ...args) {
        try {
            await handler(ctx, ...args)
        } catch(e) {
            await ctx.db.collection('never-fails-error').insert({
                error: e.message,
                stack: e.stack
            })
        }
    }
}

// TODO: remove neverFails after mainline
module.exports = {
    setQuota: neverFails(setQuota),
    syncQuotaToSchool: neverFails(syncQuotaToSchool),
    syncSeatToQuota: neverFails(syncSeatToQuota),
    relinquishQuota: neverFails(relinquishQuota),
    exchangeQuota: neverFails(exchangeQuota),
    setLeaderAttend: neverFails(setLeaderAttend)
}