const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')

route.post('/applications/',
    Config,
    async ctx => {
        let payload = ctx.request.body

        if ( ! ctx.config.applySchool ) {
            ctx.status = 409
            ctx.body = { error: 'gone' }
            return
        }

        if ( ! (payload.school && payload.school.name) ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        ctx.log.application = payload

        let existSchool = await ctx.db.collection('application').findOne({ "school.name": payload.school.name })

        if ( existSchool ) {
            ctx.status = 409
            ctx.body = {
                error: 'already exists',
                code: 'duplicated_school',
                text: '学校已报名'
            }
            return
        }
        await ctx.db.collection('application').insert({
            ...payload,
            type: 'school',
            identifier: payload.school.name,
            _id: newId(),
            created: new Date()
        })
        ctx.status = 200
        ctx.body = { message: 'accepted' }
    }
)

route.get('/applications/',
    AccessFilter('staff.application'),
    async ctx => {
        let projection = {
            _id: 0,
            id: '$_id',
            type: { $ifNull: ['$type', 'school'] },
            name: { $ifNull: ['$identifier', '$school.name', ] },
            processed: { $ifNull: ['$processed', false] },
            administrative_area: '$school.administrative_area',
        }
        if (ctx.query.seat)
            projection.seat = '$seat'
        ctx.status = 200
        ctx.body = await ctx.db.collection('application').aggregate([
            { $project: projection }
        ]).toArray()
    }
)

route.get('/applications/:id',
    AccessFilter('staff.application'),
    async ctx => {
        let result = await ctx.db.collection('application').findOne({ _id: ctx.params.id })
        if (result) {
            result.registered = Boolean(await ctx.db.collection('school').findOne({ 'school.name': result.school.name }))
            ctx.status = 200
            ctx.body = {
                type: 'school',
                name: result.identifier || result.school.name,
                ...toId(result)
            }
        }else{
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.patch('/applications/:id',
    AccessFilter('staff.application'),
    async ctx => {
        let {
            modifiedCount
        } = await ctx.db.collection('application').updateOne(
            { _id: ctx.params.id },
            { $set: ctx.request.body,
              $currentDate: { lastModified: { $type: 'date' } } }
        )
        if (modifiedCount) {
            ctx.status = 200
            ctx.body = { }
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.delete('/applications/:id',
    AccessFilter('staff.application.nuke'),
    async ctx => {
        let {
            deletedCount
        } = await ctx.db.collection('application').deleteOne({ _id: { $eq: ctx.params.id } })
        await ctx.db.collection('invitation').deleteMany({ school: ctx.params.id })
        if (deletedCount) {
            ctx.status = 200
            ctx.body = { message: 'nuked' }
        } else {
            ctx.status = 404
            ctx.body = { error: 'not found' }
        }
    }
)

route.post('/individual-applications/',
    Config,
    async ctx => {
        let payload = ctx.request.body

        if ( ! ctx.config.applyIndividual ) {
            ctx.status = 409
            ctx.body = { error: 'gone' }
            return
        }

        if ( ! (payload.school && payload.school.name) ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        ctx.log.application = payload

        let existIdentification = await ctx.db.collection('application').findOne({
            'contact.name': payload.contact && payload.contact.name,
            'identification.type': payload.identification && payload.identification.type,
            'identification.number': payload.identification && payload.identification.number
        })

        let existEmail = await ctx.db.collection('application').findOne({
            'contact.email': payload.contact.email
        })

        let existUser = await ctx.db.collection('user').findOne({
            _id: payload.contact.email
        })

        if ( existIdentification || existEmail || existUser ) {
            ctx.status = 409
            ctx.body = {
                error: 'already exists',
                ...(
                    existIdentification ? { code: 'duplicated_identification', text: '重复的身份信息' }
                  : existEmail ? { code: 'duplicated_email', text: '重复的联系人邮箱' }
                  : existUser ? { code: 'duplicated_user', text: '用户已注册' }
                  : {}
                )
            }
            return
        }
        await ctx.db.collection('application').insert({
            ...payload,
            type: 'individual',
            identifier: '个人 - ' + payload.contact.name,
            _id: newId(),
            created: new Date()
        })
        ctx.status = 200
        ctx.body = { message: 'accepted' }
    }
)

route.post('/foreigner-applications/',
    Config,
    async ctx => {
        let payload = ctx.request.body

        ctx.log.application = payload

        let existIdentification = await ctx.db.collection('foreigner').findOne({
            'first_name': payload.first_name,
            'last_name': payload.last_name,
            'passport_number': payload.passport_number,
        })

        let existEmail = await ctx.db.collection('foreigner').findOne({
            'email': payload.email
        })


        if ( existIdentification || existEmail ) {
            ctx.status = 409
            ctx.body = {
                error: 'already exists',
                ...(
                    existIdentification ? { code: 'duplicated_identification', text: 'Identity already Registered' }
                  : existEmail ? { code: 'duplicated_email', text: 'Email already registered' }
                  : {}
                )
            }
            return
        }
        await ctx.db.collection('foreigner').insert({
            ...payload,
            type: 'foreigner-individual',
            identifier: '国际个人 - ' + payload.last_name + ' ' + payload.first_name,
            _id: newId(),
            created: new Date()
        })
        ctx.status = 200
        ctx.body = { message: 'accepted' }
    }
)

module.exports = {
    routes: route.routes()
}
