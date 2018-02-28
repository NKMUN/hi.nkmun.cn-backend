const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')
const { UploadFile, GetFile, signFile } = require('./file')
const { TokenAccessFilter } = require('./auth')
const deepEqual = require('deep-equal')

async function IsSelfOrAdmins(ctx, next) {
    if (!await AccessFilter('transient.academic-staff.apply', 'admin', 'academic-director')(ctx)) {
        return false
    }

    if (!ctx.hasAccessTo('admin') && !ctx.hasAccessTo('academic-director')) {
        if (ctx.token.user !== ctx.params.user) {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
            return false
        }
    }

    if (next)
        await next()

    return true
}

function projectReviews(val) {
    return {
        reviews: val,
        review_history: val,
        aggregate_review: val
    }
}

route.get('/academic-staff-applications/',
    async ctx => {
        const { all } = ctx.request.query
        const total = await ctx.db.collection('academic_staff').count()
        const matchFilter = all ? {} : { submitted: true }
        const applications = await ctx.db.collection('academic_staff').aggregate([
            { $match: { submitted: true } },
            { $project: { _id: 1, aggregate_review: 1, name: 1, gender: 1, roles: 1 } }
        ]).toArray()
        ctx.status = 200
        ctx.body = {
            total,
            submitted: applications.length,
            pending: total - applications.length,
            data: applications.map(toId).map(application => ({
                ...application,
                reviewed: application.aggregate_review !== null,
                processed: application.invited || application.refused
            }))
        }
    }
)

route.get('/academic-staff-applications/:id',
    AccessFilter('academic-director', 'admin'),
    async ctx => {

        const application = await ctx.db.collection('academic_staff').findOne({ _id: ctx.params.id })
        if (!application) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        } else {
            // sign file download url
            const signDownloadFileUrl = arr => {
                if (!arr || !arr.length) return arr
                return arr.map(file => {
                    const token = signFile(ctx.JWT_SECRET, file.id, '1h')
                    return {
                        ...file,
                        signedUrl: `/files/${file.id}?token=${encodeURIComponent(token)}`
                    }
                })
            }
            ctx.status = 200
            application.academic_design = signDownloadFileUrl(application.academic_design)
            application.previous_work = signDownloadFileUrl(application.previous_work)
            ctx.body = toId(application)
        }
    }
)

route.get('/academic-staff-applications/user/:user',
    IsSelfOrAdmins,
    async ctx => {
        const application = await ctx.db.collection('academic_staff').findOne({ user: ctx.params.user }, projectReviews(0))
        if (application) {
            ctx.status = 200
            ctx.body = toId(application)
        } else {
            ctx.status = 404
            ctx.body = {}
        }
    }
)

route.patch('/academic-staff-applications/user/:user',
    IsSelfOrAdmins,
    async ctx => {
        const payload = getPayload(ctx)
        // strip id, _id
        delete payload.id
        delete payload._id

        const application = await ctx.db.collection('academic_staff').findOne({ user: ctx.params.user }, { _id: 1 })
        if (application) {
            if (application.submitted) {
                ctx.status = 410
                ctx.body = { error: 'not editable' }
                return
            }
            await ctx.db.collection('academic_staff').updateOne(
                { _id: application._id },
                { $set: {
                    ...payload,
                    user: ctx.params.user
                } }
            )
            ctx.status = 200
            ctx.body = toId(await ctx.db.collection('academic_staff').findOne({ _id: application._id }, projectReviews(0)))
        } else {
            const _id = newId()
            await ctx.db.collection('academic_staff').insertOne({
                _id,
                ...payload,
                user: ctx.params.user
            })
            ctx.status = 201
            ctx.body = toId(await ctx.db.collection('academic_staff').findOne({ _id }))
        }
    }
)

route.post('/academic-staff-applications/user/:user/files/',
    IsSelfOrAdmins,
    async ctx => {
        const meta = {
            user: ctx.params.user,
            access: ['academic-director', 'admin']
        }
        await UploadFile(meta)(ctx)
    }
)

route.get('/academic-staff-applications/user/:user/files/:id',
    TokenAccessFilter(IsSelfOrAdmins),
    async ctx => {
        await GetFile(ctx.params.id)(ctx)
    }
)

route.get('/academic-staff-applications/:id/reviews/',
    AccessFilter('academic-director', 'admin'),
    async ctx => {
        const application = await ctx.db.collection('academic_staff').findOne({ _id: ctx.params.id }, projectReviews(1))
        if (!application) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        } else {
            ctx.status = 200
            ctx.body = application.reviews
        }
    }
)

route.post('/academic-staff-applications/:id/reviews/',
    AccessFilter('academic-director', 'admin'),
    async ctx => {
        // right now, all academic-directors share one review entry
        // merge review when posted
        const application = await ctx.db.collection('academic_staff').findOne({ _id: ctx.params.id }, projectReviews(1))
        if (!application) {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        } else {
            const currentReview = application.reviews && application.reviews[0]
            const review = {
                ...(currentReview || {}),
                ...getPayload(ctx)
            }
            const reviewChanged = !deepEqual(currentReview, review)
            if (reviewChanged) {
                await ctx.db.collection('academic_staff').updateOne(
                    { _id: application._id },
                    { $push: { 'review_history': {
                        $each: [ currentReview ],
                        $slice: 5,
                        $position: 0
                    } } }
                )
            }
            const aggregate_review = review.score
            await ctx.db.collection('academic_staff').updateOne(
                { _id: application._id },
                { $set: { reviews: [review], aggregate_review } }
            )
            ctx.status = 200
            ctx.body = {
                id: application._id,
                changed: reviewChanged,
                reviews: [review]
            }
        }
    }
)

module.exports = {
    routes: route.routes()
}
